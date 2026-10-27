window.__ModuleLoader__.load({
	id: "dsh-plugin-shadow",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		const h = react.createElement;

		/** Agent preset id this plugin's bundle declares. */
		const PRESET_ID = "shadow";
		/**
		 * Directory the shadow adopts as its own Workspace.
		 *
		 * The browser cannot resolve the user's home directory, so this half does
		 * not invent a default: the plugin row must configure `shadowDir`, and an
		 * installation without it is reported instead of silently pointing at a
		 * path that machine does not have.
		 */
		const SHADOW_DIR = "";
		const NS = "shadow";
		/** Stable empty archive set, so a missing field never allocates per render. */
		const NO_ARCHIVED = [];

		const zh = {
			"entry.label": "影子",
			"entry.aria": "影子总控",
			"panel.title": "影子总控",
			"panel.sessions": "选择一个影子对话",
			"panel.workspaces": "先选择影子所在的工作区",
			"panel.create": "新建影子对话",
			"panel.empty": "还没有影子对话。",
			"panel.noWorkspace": "没有可选工作区。",
			"panel.untitled": "未命名影子",
			"panel.close": "关闭",
			"panel.creating": "正在创建…",
			"panel.failed": "操作未完成，请稍后再试。",
			"panel.unavailable": "影子入口尚未连接到会话服务。",
			"manage.rename": "重命名",
			"manage.renameAria": "重命名影子对话",
			"manage.archive": "归档",
			"manage.archiveAria": "归档影子对话",
			"manage.confirmArchive": "确认归档？",
			"manage.archived": "已归档"
		};

		const en = {
			"entry.label": "Shadow",
			"entry.aria": "Shadow coordinator",
			"panel.title": "Shadow coordinator",
			"panel.sessions": "Choose a shadow conversation",
			"panel.workspaces": "Choose the workspace for the shadow",
			"panel.create": "New shadow conversation",
			"panel.empty": "No shadow conversation yet.",
			"panel.noWorkspace": "No workspace is available.",
			"panel.untitled": "Untitled shadow",
			"panel.close": "Close",
			"panel.creating": "Creating…",
			"panel.failed": "The operation did not complete. Try again.",
			"panel.unavailable": "The shadow entry is not connected to the session service.",
			"manage.rename": "Rename",
			"manage.renameAria": "Rename the shadow conversation",
			"manage.archive": "Archive",
			"manage.archiveAria": "Archive the shadow conversation",
			"manage.confirmArchive": "Confirm archive?",
			"manage.archived": "Archived"
		};

		// Canvas / CanvasText are CSS system colors: they follow the page's light or
		// dark scheme without naming the app's own tokens. The earlier attempt guessed
		// `--dsw-*` names that do not exist in this build and rendered dark-on-dark.
		const panelStyle = {
			position: "fixed",
			zIndex: 80,
			width: "320px",
			maxHeight: "min(420px, 60vh)",
			overflowY: "auto",
			padding: "12px",
			borderRadius: "12px",
			border: "1px solid rgba(128,128,128,0.4)",
			background: "Canvas",
			color: "CanvasText",
			boxShadow: "0 12px 32px rgba(0,0,0,0.22)",
			fontSize: "13px",
			lineHeight: "1.55"
		};

		const titleStyle = { fontWeight: 600, marginBottom: "8px", color: "CanvasText" };
		const mutedStyle = { opacity: 0.65, marginBottom: "6px" };
		const rowStyle = {
			display: "block",
			width: "100%",
			textAlign: "left",
			padding: "8px 10px",
			marginBottom: "6px",
			borderRadius: "8px",
			border: "1px solid rgba(128,128,128,0.3)",
			background: "rgba(128,128,128,0.12)",
			color: "CanvasText",
			font: "inherit",
			cursor: "pointer",
			overflow: "hidden",
			textOverflow: "ellipsis",
			whiteSpace: "nowrap"
		};
		const rowHintStyle = { display: "block", opacity: 0.6, fontSize: "12px", marginTop: "2px" };
		const footerStyle = { display: "flex", justifyContent: "space-between", gap: "8px", marginTop: "10px" };

		/**
		 * Sidebar-foot entry: opens the shadow conversation, or offers the explicit
		 * choice that creates it.
		 * @param props - slot column state, copy, session data, and injected actions.
		 * @returns the footer action and its anchored panel.
		 */
		function ShadowEntry({ wide, t, useSessions, useWorkspaces, openShadow, createShadow, shadowDir, presetId, renameShadow, archiveShadow }) {
			const [mode, setMode] = react.useState(null);
			const [anchor, setAnchor] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [detail, setDetail] = react.useState(null);
			/** The session whose row is being renamed, and its draft title. */
			const [renaming, setRenaming] = react.useState(null);
			const [draft, setDraft] = react.useState("");
			/** The session whose archive button is armed (two-step confirm). */
			const [confirming, setConfirming] = react.useState(null);
			const inputRef = react.useRef(null);
			const rootRef = react.useRef(null);
			const sessions = useSessions((state) => state.byId);
			const workspaces = useWorkspaces((state) => state.items);
			/** Sessions the user archived. The Host keeps them in Workspace accounting, so the row must be hidden here. */
			const archivedIds = useWorkspaces((state) => state.archivedSessionIds);

			/** Workspace adopted from the dedicated shadow directory, once it exists. */
			const shadowWorkspace = react.useMemo(() => {
				const wanted = shadowDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
				return (workspaces ?? []).find((workspace) => typeof workspace.path === "string"
					&& workspace.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === wanted);
			}, [workspaces]);

			/**
			 * Shadow conversations: this preset inside the dedicated Workspace only.
			 * Other sessions created with the same preset elsewhere stay out of it, so the
			 * entry never reopens a conversation that lives in a project workspace.
			 * Archived sessions are excluded as well: the runtime's archive flag is a
			 * registry-global set that never touches the Workspace's own session list,
			 * so without this filter an archived row would survive its own archive.
			 */
			const shadows = react.useMemo(() => {
				if (shadowWorkspace === undefined) return [];
				const ids = Array.isArray(shadowWorkspace.sessionIds) ? shadowWorkspace.sessionIds : [];
				const archived = Array.isArray(archivedIds) ? archivedIds : NO_ARCHIVED;
				return ids
					.filter((id) => !archived.includes(id))
					.map((id) => [id, (sessions ?? {})[id]])
					.filter(([, summary]) => summary !== undefined && summary !== null
						&& summary.projectionValues !== undefined && summary.projectionValues !== null
						&& summary.projectionValues.agentPreset === presetId)
					.map(([id, summary]) => ({ id, title: typeof summary.displayTitle === "string" ? summary.displayTitle.trim() : "" }));
			}, [sessions, shadowWorkspace, archivedIds]);

			const open = mode !== null;

			/** The session the shell currently shows in its main view. */
			const currentSessionId = react.useMemo(() => {
				const found = Object.entries(sessions ?? {}).find(([, summary]) => summary !== undefined && summary !== null
					&& ((summary.retainedBy === undefined || summary.retainedBy === null) ? 0 : summary.retainedBy.mainView ?? 0) > 0);
				return found === undefined ? undefined : found[0];
			}, [sessions]);

			/** Model the open session runs on, so the shadow starts on a working route. */
			const currentModel = react.useMemo(() => {
				const summary = currentSessionId === undefined ? undefined : (sessions ?? {})[currentSessionId];
				const selection = summary === undefined || summary === null ? undefined : summary.projectionValues?.modelSelection;
				const chosen = selection?.next ?? selection?.lastUsed;
				if (chosen === undefined || chosen === null) return undefined;
				return {
					provider: chosen.provider,
					model: chosen.model,
					...(chosen.reasoningEffort === undefined || chosen.reasoningEffort === null
						? {} : { reasoningEffort: chosen.reasoningEffort })
				};
			}, [sessions, currentSessionId]);

			react.useLayoutEffect(() => {
				if (!open) return undefined;
				const place = () => {
					const node = rootRef.current;
					if (node === null) return;
					const rect = node.getBoundingClientRect();
					setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
				};
				place();
				window.addEventListener("resize", place);
				return () => { window.removeEventListener("resize", place); };
			}, [open]);

			primitives.useDismissOnOutsidePointer(rootRef, open, () => { setMode(null); });

			const close = () => { setMode(null); setDetail(null); };

			const trigger = () => {
				setDetail(null);
				if (shadows.length === 1) {
					openShadow(shadows[0].id);
					return;
				}
				if (shadows.length > 1) {
					setMode("sessions");
					return;
				}
				// First use: adopt the dedicated directory as a Workspace and create there,
				// so one click reaches a conversation outside every project workspace.
				void createIn(currentModel);
			};

			const createIn = async (selection) => {
				setBusy(true);
				setDetail(null);
				try {
					await createShadow(selection);
					setMode(null);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					console.error("[dsh-plugin-shadow] create failed", error);
					setDetail(`${t("panel.failed")} ${message}`);
				} finally {
					setBusy(false);
				}
			};

			const fail = (error) => {
				const message = error instanceof Error ? error.message : String(error);
				console.error("[dsh-plugin-shadow] manage failed", error);
				setDetail(message);
			};

			const beginRename = (item) => {
				setConfirming(null);
				setRenaming(item.id);
				setDraft(item.title);
			};

			const commitRename = async (item) => {
				const title = draft.trim();
				setBusy(true);
				try {
					await renameShadow(item.id, title);
					setRenaming(null);
				} catch (error) {
					fail(error);
				} finally {
					setBusy(false);
				}
			};

			const archiveRow = async (item) => {
				setBusy(true);
				setDetail(null);
				try {
					await archiveShadow(item.id);
					setConfirming(null);
					setDetail(t("manage.archived"));
				} catch (error) {
					fail(error);
				} finally {
					setBusy(false);
				}
			};

			const actionStyle = {
				padding: "4px 8px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.3)",
				background: "transparent",
				color: "inherit",
				font: "inherit",
				fontSize: "12px",
				cursor: "pointer"
			};

			const rows = shadows.map((item) => {
				const title = item.title.length > 0 ? item.title : t("panel.untitled");
				// Renaming row: an inline editor replaces the whole row.
				if (renaming === item.id) {
					return h("div", { key: item.id, style: { display: "flex", gap: "6px" } },
						h("input", {
							ref: inputRef,
							value: draft,
							onChange: (event) => { setDraft(event.currentTarget.value); },
							onKeyDown: (event) => {
								if (event.key === "Enter") { void commitRename(item); }
								if (event.key === "Escape") { setRenaming(null); }
							},
							style: { ...rowStyle, flex: "1", marginBottom: "0", cursor: "text" },
							autoFocus: true,
							"aria-label": t("manage.renameAria")
						}),
						h("button", { type: "button", style: { ...actionStyle, display: "flex", alignItems: "center" }, disabled: busy, onClick: () => { void commitRename(item); } }, h(primitives.IconCheckOutlineRegular, { size: 14 })),
						h("button", { type: "button", style: actionStyle, onClick: () => { setRenaming(null); } }, h(primitives.IconCloseOutlineRegular, { size: 14 })));
				}
				const armed = confirming === item.id;
				return h("div", { key: item.id, style: { display: "flex", gap: "6px", alignItems: "center" } },
					h("button", {
						type: "button",
						style: { ...rowStyle, flex: "1", marginBottom: "0" },
						onClick: () => { openShadow(item.id); setMode(null); }
					}, title),
					h("button", {
						type: "button", style: { ...actionStyle, display: "flex", alignItems: "center" }, disabled: busy,
						title: t("manage.rename"), "aria-label": t("manage.renameAria"),
						onClick: () => { beginRename(item); }
					}, h(primitives.IconEditOutlineRegular, { size: 14 })),
					armed
						? h("button", {
							type: "button", style: { ...actionStyle, color: "#c0392b", borderColor: "#c0392b" },
							disabled: busy, onClick: () => { void archiveRow(item); }
						}, t("manage.confirmArchive"))
						: h("button", {
							type: "button", style: { ...actionStyle, display: "flex", alignItems: "center" }, disabled: busy,
							title: t("manage.archive"), "aria-label": t("manage.archiveAria"),
							onClick: () => { setConfirming(item.id); }
						}, h(primitives.IconArchiveOutlineRegular, { size: 14 })));
			});

			const panel = open && anchor !== null
				? h("div", {
					style: { ...panelStyle, left: `${String(anchor.left)}px`, bottom: `${String(anchor.bottom)}px` },
					role: "dialog",
					"aria-label": t("panel.title")
				},
				h("div", { style: titleStyle }, t("panel.title")),
				h("div", { style: mutedStyle }, t("panel.sessions")),
				busy ? h("div", { style: mutedStyle }, t("panel.creating")) : null,
				detail === null ? null : h("div", { style: mutedStyle }, detail),
				rows,
				h("div", { style: footerStyle },
					h(primitives.Button, { variant: "outline", size: "sm", disabled: busy, onClick: () => { void createIn(currentModel); } }, t("panel.create")),
					h(primitives.Button, { variant: "ghost", size: "sm", onClick: close }, t("panel.close"))))
				: null;

			return h("div", { ref: rootRef },
				h(primitives.Button, {
					variant: "ghost",
					size: "sm",
					icon: h(primitives.IconInspectOutlineRegular, { size: 16 }),
					"aria-expanded": open,
					"aria-label": t("entry.aria"),
					onClick: trigger
				}, wide ? t("entry.label") : undefined),
				panel);
		}

		const inject = ["slots", "locale", "uiWorkspace", "sessions", "workspaces"];

		/**
		 * @param ctx - client root context.
		 * @param config - this entry's row config; `shadowDir` is required.
		 */
		function apply(ctx, config) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "shadow: dictionaries");

			const shadowDir = typeof config?.shadowDir === "string" && config.shadowDir.length > 0
				? config.shadowDir
				: SHADOW_DIR;
			const presetId = typeof config?.shadowPresetId === "string" && config.shadowPresetId.length > 0
				? config.shadowPresetId
				: PRESET_ID;
			if (shadowDir.length === 0) {
				// An unconfigured directory would make every panel action fail with a
				// confusing path error; name the actual cause once, up front.
				ctx.logger?.warn?.("shadow: no shadowDir configured on the plugin row; the shadow panel cannot create or list conversations");
			}
			const nav = ctx.get("uiWorkspace");
			const catalog = ctx.get("sessions");
			const registry = ctx.get("workspaces");
			const openShadow = (sessionId) => {
				if (nav === undefined) throw new Error("uiWorkspace service is unavailable");
				nav.openSession(sessionId);
			};
			/**
			 * Read a workspace identity out of any adopt result generation, including a
			 * "this already exists" refusal that still carries the existing entity.
			 * @param result - the resolver's return value.
			 * @returns the workspace id, or undefined when the result carries none.
			 */
			const adoptedWorkspaceId = (result) => {
				const candidates = [
					result?.value?.workspace,
					result?.workspace,
					result?.value,
					result?.error?.workspace,
					result?.error,
					result,
				];
				for (const candidate of candidates) {
					const id = candidate?.workspaceId;
					if (typeof id === "string" && id.length > 0) return id;
				}
				return undefined;
			};
			const createShadow = async (selection) => {
				if (nav === undefined) throw new Error("uiWorkspace service is unavailable");
				if (catalog === undefined) throw new Error("sessions service is unavailable");
				if (registry === undefined) throw new Error("workspaces service is unavailable");
				if (shadowDir.length === 0) throw new Error("no shadowDir configured on the plugin row");
				// Adopt the dedicated directory as a Workspace. Adopting is idempotent in
				// intent, but a runtime may report an already-registered directory as a
				// refusal that still carries the existing entity — that is success, not a
				// failure to adopt, so read the identity before deciding.
				const adopted = await registry.create({ path: shadowDir });
				const workspaceId = adoptedWorkspaceId(adopted);
				if (workspaceId === undefined) {
					throw new Error(`could not adopt ${shadowDir}: ${JSON.stringify(adopted).slice(0, 240)}`);
				}
				const sessionId = await catalog.create({ workspaceId, agentPreset: presetId });
				if (typeof sessionId !== "string" || sessionId.length === 0) {
					throw new Error("session creation returned no identity");
				}
				// Pin the model the user already runs on. A fresh Session otherwise keeps
				// whatever route it last used, which may reject this deployment's
				// reasoning parameters before the first turn.
				if (selection !== undefined && typeof catalog.selectModel === "function") {
					try {
						await catalog.selectModel({ sessionId, ...selection });
					} catch (error) {
						console.error("[dsh-plugin-shadow] model pin failed", error);
					}
				}
				nav.openSession(sessionId);
				return sessionId;
			};
			/** Rename through the official Session binding; the host normalizes the title. */
			const renameShadow = async (sessionId, title) => {
				if (catalog === undefined) throw new Error("sessions service is unavailable");
				const result = await catalog.using(sessionId, { source: "workspaceOperation" },
					(reference) => reference.binding.session.rename(title));
				if (result === undefined || result.ok !== true) {
					throw new Error(`rename failed: ${JSON.stringify(result?.error ?? result).slice(0, 200)}`);
				}
			};
			/**
			 * Archive through the official Workspace store: the runtime has no session delete.
			 * The `uiWorkspace` wrapper resolves even when the Host refuses (an active
			 * Session, an unknown id), so its reply carries nothing to inspect; calling
			 * the store directly returns the Remote result, which keeps a refusal
			 * visible instead of letting it pass for success.
			 */
			const archiveShadow = async (sessionId) => {
				if (registry === undefined) throw new Error("workspaces service is unavailable");
				if (typeof registry.archiveSession !== "function") {
					throw new Error("archive is not available in this runtime");
				}
				const result = await registry.archiveSession(sessionId);
				if (result !== undefined && result !== null && result.ok === false) {
					const error = result.error;
					const message = typeof error?.message === "string" && error.message.length > 0
						? error.message
						: JSON.stringify(error ?? result).slice(0, 200);
					throw new Error(message);
				}
			};

			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "shadow-entry", locale: NS,
					inject: () => ({ openShadow, createShadow, shadowDir, presetId, renameShadow, archiveShadow }) },
				ShadowEntry
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
