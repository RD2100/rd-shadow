# dsh-plugin-shadow

> When you have more DSH conversations than you can track, let one of them stand in your seat: watching progress and handing work to the right Session.

**Repository**: [RD2100/rd-shadow](https://github.com/RD2100/rd-shadow)　**Package**: `dsh-plugin-shadow`

*[中文](README.md)*

The shadow is **a DSH Session that lives in its own directory**, with three tools:

| Tool | Purpose |
|---|---|
| `shadow_targets` | List workspaces and Sessions: id, live state (`idle`/`cold`/`busy`), archived and subagent markers, title |
| `shadow_inspect` | Read one Session without waking it: state, directory, current model, sequence numbers; optional event pages via `afterSeq`/`limit` |
| `shadow_dispatch` | Deliver one message to a Session. The message carries `source={kind:'agent-message', form:'relay', senderSessionId}`, so the receiver's log records who sent it |

Delivery is idempotent: replaying the same tool call yields the same message id and never delivers twice. To send again, call again.

| Receipt `status` | Meaning |
|---|---|
| `durable` | Written to the target log and admitted into a turn |
| `accepted` | In the target inbox, not yet admitted |
| `already-delivered` | This message was delivered before |
| `rejected` | Not delivered; `reason` names why (`busy`/`pending`/`archived`/`workspace-session-mismatch`/…) |
| `unknown` | Confirmation was lost after sending. **Do not retry**: a retry derives a new message id. Verify with `shadow_inspect` |

## Permissions and safety

Shadow Sessions are pinned to `danger-full-access` and tool calls never wait for approval (see [decision ADR-001](https://github.com/RD2100/rd-shadow/blob/main/docs/decisions.md)). The shadow can read and write the whole filesystem, reach the network, and read other Sessions' content. Use it only when you trust its instructions and the workspaces it reads.

## Requirements

| Item | Requirement |
|---|---|
| DSH | `dsh-desktop-next 2.0.20-next` (harness `0.2.1-rc.3`). Depends on that version's internal service contracts; **no cross-version guarantee** |
| Node | `>= 22.19` |
| profile | A web / desktop profile with a GUI (the plugin has a browser half) |

## Install

- **desktop profile**: the in-app plugin page, or ask an agent to call `plugin_manager` `install_bundle spec=<repo path>`.
- **web / tui profile**: `dsh plugin --profile web add <repo path or https://github.com/RD2100/rd-shadow>`.
- **Manual**: in the profile `package.json`, add `"dsh-plugin-shadow"` to `dsh.profile.bundles` and `"dsh-plugin-shadow": "file:<repo path>"` to `dependencies`.

## Configuration

`shadowDir` is the shadow's identity: only Sessions whose `cwd` equals it are the shadow, get the pinned permission, and see the three tools. Default: `<home>/dsh-shadow`.

**The host row (`shadow`) and the `shadow-tools` row inside the preset must name the same `shadowDir`.** When upgrading from before 0.11.0 and keeping the old shadow directory, override both rows in the profile, or existing shadow Sessions stop being recognized. See [operations §4](https://github.com/RD2100/rd-shadow/blob/main/docs/operations.md).

After a start the host log should contain:

```text
shadow: directory <shadow directory>
shadow: build <12-hex hash>        ← equals `node scripts/fingerprint.mjs` in the checkout
shadow: permission identity danger-full-access; interactive approvals are disabled
```

## Known limitations

| Limitation | Notes |
|---|---|
| No interactive approval | See "Permissions and safety" |
| GUI profiles only | The client half needs a browser |
| Changing `lib/*.js` needs a DSH restart | HMR does not watch plugin code |
| No cross-version DSH support | See "Requirements" |

## Development

```sh
node tests/run.mjs          # every offline check (CI: ubuntu/windows × Node 22/24)
```

Rules, design, and tasks live in the repository's `docs/` and `AGENTS.md` (not shipped in the npm package; Chinese):

- [AGENTS.md](https://github.com/RD2100/rd-shadow/blob/main/AGENTS.md): implementer rules
- [Overview design](https://github.com/RD2100/rd-shadow/blob/main/docs/overview-design.md) · [Detailed design](https://github.com/RD2100/rd-shadow/blob/main/docs/detailed-design.md) · [Test cases](https://github.com/RD2100/rd-shadow/blob/main/docs/test-cases.md) · [Decisions](https://github.com/RD2100/rd-shadow/blob/main/docs/decisions.md) · [Task cards](https://github.com/RD2100/rd-shadow/blob/main/docs/tasks.md) · [Operations](https://github.com/RD2100/rd-shadow/blob/main/docs/operations.md)

## License

MIT, see [LICENSE](LICENSE).
