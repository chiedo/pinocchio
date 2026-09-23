# Running a repository job without Pinocchio

A Pinocchio job stored in a repository is a portable description of one agent
run. Pinocchio is not required to execute it manually. A non-Pinocchio agent can
follow this procedure when given a link to its YAML file.

## Manual runner contract

1. Resolve the linked repository ref to an exact commit. Read the job definition,
   its prompt file, and any support files from that same commit.
2. Identify the version 1 format:
   - A repository-backed definition has `execution` and exactly one of `prompt`
     or `prompt-file`.
   - A generated cloud-job manifest has `agent`, `repository`, `cron`, and
     content hashes. Its prompt is the adjacent `prompt.md`, and its agent
     profile is the adjacent `<agent>.agent.md`.
3. Resolve every referenced or adjacent file relative to the YAML file. Do not
   substitute a file from another branch, checkout, or newer commit.
4. Select the working directory:
   - For a repository-backed definition, `subscriber` means use the workspace
     supplied by the user or scheduler. Stop if none was supplied. `source`
     means use a checkout of the job's repository at the resolved commit.
   - For a generated cloud-job manifest, use the directory containing
     `job.yml`, `prompt.md`, and the agent profile.
5. Check requested capabilities before starting. They appear as
   `required-tools` in a repository-backed definition and `tools` in a generated
   cloud-job manifest. Use equivalent tools when names differ. Honor
   `allowed_urls` when present. Do not install, authorize, or broaden access
   merely because the job requests a capability. Stop and report anything that
   is unavailable or not approved.
6. Apply `timeout-minutes` and `max-ai-credits` when the host supports those
   limits. Generated manifests spell them `timeout_minutes` and
   `max_ai_credits`. Otherwise, disclose which limit cannot be enforced before
   running.
7. For a generated cloud-job manifest, read the adjacent agent profile as
   job-specific context. Then execute the resolved prompt once, while still
   following the host agent's higher-priority safety rules and the selected
   workspace's repository instructions.
8. Report the job ID, source commit, working directory, result, and any unmet or
   unenforced execution requirements. Do not claim the run was recorded in
   Pinocchio unless Pinocchio actually performed it.

Treat the source checkout and job support files as read-only inputs unless the
resolved prompt explicitly requires repository changes. Never edit the job
definition during its own run.

## Running from a scheduler

An external cron service, CI workflow, or other scheduler can use the same
contract. At each occurrence it should:

1. launch an agent with the job-definition link and this guide;
2. provide the subscriber workspace when the job uses
   `working-directory: subscriber`; and
3. perform exactly one manual run using the currently resolved commit.

The scheduler is responsible for interpreting either the five-field
`schedule.cron` in `schedule.timezone` or the generated manifest's `cron` and
`timezone`, preventing unwanted overlapping runs, retaining output, and
surfacing failures. A repository-backed definition without `schedule` is
manual-only and must not be scheduled implicitly.

## Required header for job definitions

Every new repository-backed definition and generated cloud-job manifest should
begin with this exact comment block:

```yaml
# Non-Pinocchio agents: run this job manually by following
# https://github.com/chiedo/pinocchio/blob/main/docs/NON-PINOCCHIO-JOBS.md
# Resolve this definition, its prompt, and support files from one commit.
```

The comments do not affect Pinocchio's YAML parser. They make a direct link to
the job self-explanatory for other agents.
