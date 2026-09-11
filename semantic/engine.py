"""Private, offline embedding/FAISS process. Downloads require explicit prepare."""
import fcntl
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import stat
import sys
import signal
import urllib.request

os.umask(0o077)
SPEC = json.loads(Path(__file__).with_name("model.json").read_text())
MAX_RECORDS = 5000
MAX_FRAME = 8 * 1024 * 1024


def require(condition, code):
    if not condition:
        raise RuntimeError(code)


def private_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "INSECURE_SEMANTIC_FILE")
    return info


def private_directory(path):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and info.st_mode & 0o077 == 0, "INSECURE_SEMANTIC_DIRECTORY")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked_model(root):
    private_directory(root)
    for name, spec in SPEC["files"].items():
        path = root / name
        private_directory(path.parent)
        require(private_file(path).st_size == spec["bytes"], "MODEL_SIZE_MISMATCH")
        require(digest(path.read_bytes()) == spec["sha256"], "MODEL_HASH_MISMATCH")


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def prepare(root):
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_directory(root)
    for name, spec in SPEC["files"].items():
        path = root / name
        path.parent.mkdir(mode=0o700, exist_ok=True)
        private_directory(path.parent)
        temporary = path.with_name(path.name + "." + str(os.getpid()) + ".download")
        url = f'https://huggingface.co/{SPEC["model"]}/resolve/{SPEC["revision"]}/{name}'
        try:
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open("xb") as output:
                remaining = spec["bytes"]
                while remaining:
                    chunk = response.read(min(65536, remaining))
                    require(bool(chunk), "MODEL_DOWNLOAD_TRUNCATED")
                    output.write(chunk)
                    remaining -= len(chunk)
                require(not response.read(1), "MODEL_DOWNLOAD_OVERSIZED")
                output.flush()
                os.fsync(output.fileno())
            require(digest(temporary.read_bytes()) == spec["sha256"], "MODEL_HASH_MISMATCH")
            os.replace(temporary, path)
            sync_directory(path.parent)
        finally:
            if temporary.exists():
                temporary.unlink()
    checked_model(root)
    return {"status": "prepared", "bytes": sum(x["bytes"] for x in SPEC["files"].values())}


def offline(event, _args):
    if event == "socket.connect":
        raise RuntimeError("SEMANTIC_NETWORK_DISABLED")


class Engine:
    def __init__(self, root):
        sys.addaudithook(offline)
        for package, version in {
            "faiss-cpu": "1.15.0", "numpy": "2.5.3", "onnxruntime": "1.30.0", "tokenizers": "0.23.2",
        }.items():
            require(importlib.metadata.version(package) == version, "SEMANTIC_RUNTIME_VERSION_MISMATCH")
        checked_model(root)
        import faiss
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.faiss, self.np = faiss, np
        faiss.omp_set_num_threads(1)
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(root / "onnx/model_quantized.onnx"),
                                           sess_options=options, providers=["CPUExecutionProvider"])
        self.tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=SPEC["maxTokens"])
        self.tokenizer.enable_padding(pad_id=0, pad_token="[PAD]")
        self.lock = None
        self.cached = None
        self.index = None
        self.records = []

    def embed(self, texts):
        require(isinstance(texts, list) and 0 < len(texts) <= 32, "INVALID_EMBED_BATCH")
        require(all(isinstance(text, str) and 0 < len(text) <= 32768 for text in texts), "INVALID_EMBED_TEXT")
        encoded = self.tokenizer.encode_batch(texts)
        arrays = {
            "input_ids": self.np.asarray([item.ids for item in encoded], dtype=self.np.int64),
            "attention_mask": self.np.asarray([item.attention_mask for item in encoded], dtype=self.np.int64),
            "token_type_ids": self.np.asarray([item.type_ids for item in encoded], dtype=self.np.int64),
        }
        inputs = {item.name: arrays[item.name] for item in self.session.get_inputs()}
        hidden = self.session.run(None, inputs)[0]
        mask = arrays["attention_mask"][:, :, None].astype(self.np.float32)
        vectors = (hidden * mask).sum(axis=1) / mask.sum(axis=1).clip(min=1)
        vectors = self.np.ascontiguousarray(vectors, dtype=self.np.float32)
        require(vectors.shape == (len(texts), SPEC["dimensions"]) and bool(self.np.isfinite(vectors).all()), "INVALID_EMBEDDING")
        self.faiss.normalize_L2(vectors)
        return vectors

    def execute(self, request):
        action = request["action"]
        if action == "acquire":
            require(self.lock is None, "BUILDER_ALREADY_LOCKED")
            path = Path(request["path"])
            private_directory(path.parent)
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            try:
                private_file(path)
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BaseException:
                os.close(fd)
                raise
            self.lock = fd
            return {"status": "locked"}
        if action == "build":
            require(self.lock is not None, "BUILDER_LOCK_REQUIRED")
            records = request["records"]
            require(isinstance(records, list) and len(records) <= MAX_RECORDS, "INDEX_CAPACITY_EXCEEDED")
            target = Path(request["path"])
            private_directory(target.parent)
            index = self.faiss.IndexFlatIP(SPEC["dimensions"])
            for offset in range(0, len(records), 16):
                index.add(self.embed([item["content"] for item in records[offset:offset + 16]]))
            data = self.faiss.serialize_index(index).tobytes()
            with target.open("xb") as output:
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            return {"sha256": digest(data), "bytes": len(data)}
        if action == "search":
            path = Path(request["path"])
            private_directory(path.parent)
            info = private_file(path)
            require(info.st_size <= MAX_RECORDS * SPEC["dimensions"] * 4 + 8192, "INDEX_CAPACITY_EXCEEDED")
            signature = (str(path), info.st_ino, info.st_mtime_ns, info.st_size, request["sha256"])
            if signature != self.cached:
                data = path.read_bytes()
                require(digest(data) == request["sha256"], "INDEX_HASH_MISMATCH")
                index = self.faiss.deserialize_index(self.np.frombuffer(data, dtype=self.np.uint8))
                require(isinstance(index, self.faiss.IndexFlatIP) and index.d == SPEC["dimensions"]
                        and index.ntotal == len(request["records"]), "INDEX_MODEL_MISMATCH")
                self.index, self.records, self.cached = index, request["records"], signature
            if not self.records:
                return {"candidates": []}
            scores, positions = self.index.search(self.embed([request["query"]]), min(50, len(self.records)))
            candidates = []
            for score, position in zip(scores[0], positions[0]):
                if position >= 0:
                    record = self.records[int(position)]
                    candidates.append({"id": record["id"], "revision": record["revision"], "score": float(score)})
            return {"candidates": candidates}
        raise RuntimeError("INVALID_SEMANTIC_ACTION")


def error_code(error):
    if isinstance(error, BlockingIOError):
        return "BUILDER_BUSY"
    if isinstance(error, FileNotFoundError):
        return "SEMANTIC_FILE_MISSING"
    text = str(error)
    return text if text.isascii() and text.replace("_", "").isupper() else "SEMANTIC_ENGINE_FAILED"


def main():
    root = Path(sys.argv[2])
    if sys.argv[1] == "prepare":
        print(json.dumps(prepare(root)))
        return
    engine = Engine(root)
    print(json.dumps({"ready": True}), flush=True)
    while True:
        line = sys.stdin.buffer.readline(MAX_FRAME + 1)
        if not line:
            break
        require(len(line) <= MAX_FRAME and line.endswith(b"\n"), "SEMANTIC_FRAME_OVERSIZED")
        request = json.loads(line)
        try:
            signal.alarm(125 if request["payload"].get("action") == "build" else 10)
            value = engine.execute(request["payload"])
            signal.alarm(0)
            print(json.dumps({"id": request["id"], "value": value}), flush=True)
        except Exception as error:
            signal.alarm(0)
            print(json.dumps({"id": request["id"], "code": error_code(error)}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"code": error_code(error)}), flush=True)
        sys.exit(1)
