# Setting up your first agent

**Start with a Chief of Staff:** an agent that turns scattered notes into a
prioritized plan, drafts updates, and remembers your working preferences.
Add connectors as needed, rather than requiring every service on day one.

This is a generic, public-safe example, not a copy of anyone's private profile.
It includes no company-specific systems, account IDs, internal links, or model
preferences. Pinocchio's [preview compatibility limits](COMPATIBILITY.md) still
apply; optional connectors have their own availability and access requirements.

## 1. Install and enroll

Follow the [README prerequisites and installation](../README.md#quick-start).
From the Pinocchio checkout:

```bash
npm run setup -- --name chief-of-staff --global
copilot --agent chief-of-staff
```

Approve the extension if prompted. Setup prints the profile path, normally
`~/.copilot/agents/chief-of-staff.agent.md`. Keep the checkout and its dependencies.
If you already have an agent with this name, use a new name rather than replacing
its role. For project-only memory, use `--repository /absolute/path/to/project`
instead of `--global`.

Default setup requires Python 3.12 and prepares local semantic search, including
about 24 MB of model files plus pinned Python dependencies. Notes stay local
during embedding. To opt out, append `--keyword-only`; that agent stays
keyword-only until you explicitly rerun with `--hybrid`.

## 2. Give it a useful role and tools

Use [the Chief of Staff template](../examples/chief-of-staff.agent.md).
In the agent session opened from this checkout, paste:

```text
Read examples/chief-of-staff.agent.md and my own agent profile. Apply the
example's generic role instructions and merge its tools into my profile.
Preserve my name, model settings, existing tools, generated Pinocchio memory
tools, and entire managed memory block. Do not copy the template's comment.
Do not install or enable MCP servers, authenticate, or change permissions yet.
Show which optional connectors the example references.
```

Or edit manually: merge the template's `tools` list into the existing YAML list,
update the description, and replace the authored role text **above**
`<!-- pinocchio-memory:v1 -->`. Keep everything from that marker onward.
Never overwrite an enrolled profile with the template file: it deliberately
does not contain generated memory wiring. Do not rename or move an enrolled
profile; its path is part of its identity.

Keep only the optional MCP entries you intend to use. No MCP is required for
working with notes you provide directly. Restart after editing the profile.

**Two switches must be on:** the server must be configured/enabled in Copilot
CLI, and its tools must be allowed by the agent profile. For example:

```yaml
tools:
  # Keep the rest of your existing tools, especially Pinocchio's generated ones.
  - computer-use/*
  - workiq/*
  - slack/*
```

The `server/*` syntax enables that server's tools in the agent's allowlist; it
does **not** install, connect, authenticate, or auto-approve them. Server names
must match your configuration exactly. See the
[custom-agent tool reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration).
Prefer server-scoped entries over `tools: ["*"]`, which exposes every available
tool, including future additions.

## 3. Connect the services you use

Start with **WorkIQ for Microsoft 365**, **Slack for team context**, and
**Computer Use only if you need desktop interaction**. Each is optional.
Read the provider's current requirements before installing third-party code.
Publicly documented does not mean free, anonymous, available on every platform,
or approved by your organization.

| Capability | Template entry / configured name | Public setup and requirements |
|---|---|---|
| Desktop interaction | `computer-use/*` / `computer-use` | Use the built-in server **if your CLI exposes it**. Run `copilot mcp get computer-use` first. Availability depends on your CLI/platform/policy; do not install an unrelated similarly named package. See [Copilot releases](https://github.com/github/copilot-cli/releases). |
| Microsoft 365 | `workiq/*` / `workiq` | [Microsoft Work IQ](https://github.com/microsoft/work-iq): Microsoft account, tenant access, and any required admin consent. |
| Slack | `slack/*` / `slack` | [Slack's official MCP guide](https://docs.slack.dev/ai/slack-mcp-server): approved client/app and workspace OAuth. An endpoint alone is not sufficient. |
| Observability | `datadog/*` / `datadog` | [Datadog setup](https://docs.datadoghq.com/mcp_server/setup/): select your site, configure OAuth and resource permissions. Use the public provider setup, not a private/unstable configuration. |
| Kusto / Fabric RTI | `kusto-mcp/*` / `kusto-mcp` | [Public Fabric RTI connector](https://github.com/weijie-tan3/fabric-rti-mcp): follow its install/auth instructions with **your own** service/database. Community connector; review before installing. |
| Trino | `trino-mcp/*` / `trino-mcp` | [Public Trino connector](https://github.com/weijie-tan3/trino-mcp): configure **your own** host/catalog/schema and supported authentication. Community connector; use read-only credentials. |

This covers the connector categories used in the example workflow, without
shipping private warehouse hosts, OAuth client IDs, tenant settings, or plugins.
If an installer chooses a different name, either configure the name shown above
or change both the profile and your enable command to match.

### WorkIQ: a public installation path

Inside Copilot CLI:

```text
/plugin marketplace add microsoft/work-iq
/plugin install workiq@work-iq
```

Restart after installation. Complete the provider's sign-in and consent flow.
The standard plugin and preview variants expose different tools; don't assume
that a document read/write API exists merely because WorkIQ is connected.
The wildcard picks up the tools your installed `workiq` server actually exposes.

### Slack and optional data services

Use the provider links in the table and Copilot's
[MCP configuration guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers).
Slack's public endpoint is `https://mcp.slack.com/mcp`, but Slack does not support
dynamic client registration: use an approved integration or an administrator-
configured client. Do not copy another client's OAuth identity or browser cookies.

For Datadog, select the endpoint for your own site. For Kusto and Trino, review
the public connector READMEs and supply your own authorized infrastructure.
Do not paste passwords, access tokens, or MFA secrets into agent prompts,
committed profiles, or shell command history. Follow provider secret handling.

### Enable configured servers

The [enablement script](../scripts/enable-example-mcps.sh) uses Copilot's normal
configuration commands. Run it in a terminal from the Pinocchio checkout:

```bash
# See your configured servers first.
copilot mcp list

# Enable only the basics you configured and want.
bash scripts/enable-example-mcps.sh computer-use workiq slack

# Or, after configuring ALL six table entries:
bash scripts/enable-example-mcps.sh --all
```

The script enables named servers, shows their saved configuration, reports each
failure, and exits nonzero if any fail. Successful changes are not rolled back.
It never installs plugins, overwrites MCP definitions, supplies credentials,
accepts consent, or grants auto-approval. No arguments prints help without changes.
Do not run it simply to enable services you do not need.

Inside an interactive CLI session, the equivalent for one server is:

```text
/mcp enable computer-use
```

If Computer Use is absent, continue without it; an allowlist cannot make an
unavailable feature appear. When present, follow its OS permission prompts
(including macOS Accessibility and Screen Recording when requested). Do not
bypass consent with shell automation. Pinocchio does not configure OS permissions.

## 4. Verify, then give it real work

Start a **fresh** session:

```bash
copilot --agent chief-of-staff
```

Try these individually; use only the connectors you enabled:

| Check | Prompt |
|---|---|
| Useful without connectors | "Turn these notes into three priorities, open questions, and a draft update: [paste non-sensitive notes]. Don't send anything." |
| Memory | "Remember this synthetic preference: demo updates should start with the decision needed. Confirm the save committed." Then ask for it in a fresh session. |
| WorkIQ | "Use WorkIQ to summarize my next meeting. Read only; don't change or send anything." |
| Slack | "Find the most recent discussion of [topic] in [channel I can access]. Read the thread and cite it; don't post." |
| Computer Use | "Use Computer Use to inspect Calculator without changing anything." |
| Optional data connectors | "Discover the available schemas or dashboards using [server]. Read metadata only; don't run expensive queries or change resources." |

The agent should discover deferred tools before claiming they are missing.
A successful settings check is not a successful tool call. If a probe fails,
check `/mcp`, authentication, organization policy, OS permissions, and the
profile's exact `server/*` entry; restart after configuration changes.
Native UI reading does not prove screenshots or clicking work, and connector
access does not grant permission to send messages or perform writes.

## 5. Make the next agent

Run setup with a new name, then adapt the role and tool list:

```bash
npm run setup -- --name researcher --global
copilot --agent researcher
```

Ask it to use this template but specialize in research, keeping only the tools
it needs and preserving its generated memory wiring. Each enrolled agent gets
its own memory. Put truly shared rules in the shared file printed by setup
(normally `~/.copilot/pinocchio/AGENTS.md`); keep individual roles in their profiles.
Shared prose does not change YAML tool allowlists: each new profile needs its
own MCP entries. Enabling a server does not automatically expose it to every
agent with a restricted tool list.

Keep personal profiles and memory stores local. Publishing this generic example
does not require publishing your own agents, credentials, or conversations.
