import json
M=[
 dict(name='G1_gate_exemption_dropped', file='src/main/workspaces.ts',
      old="    !!db &&\n    !isPlainOwnAnchor(targetForGate, (id) => store.getWorkspace(id))\n", new="    !!db\n", rig=True),
 dict(name='G2_isPlainOwnAnchor_orchestrators_exempt', file='src/main/wave-run-id.ts',
      old="return !nodeOrchestrates(ws) && nearestOrchestratorId(ws, lookup) === ws.id;", new="return nearestOrchestratorId(ws, lookup) === ws.id;", rig=True),
 dict(name='G3_isPlainOwnAnchor_members_exempt', file='src/main/wave-run-id.ts',
      old="return !nodeOrchestrates(ws) && nearestOrchestratorId(ws, lookup) === ws.id;", new="return !nodeOrchestrates(ws);", rig=True),
 dict(name='H1_send_drops_toRunId_branch', file='src/cli/bus-verbs.ts',
      old="if (!anchored && toRunId !== to) return;", new="if (!anchored) return;", cli=True),
 dict(name='H2_send_judges_members', file='src/cli/bus-verbs.ts',
      old="if (!anchored && toRunId !== to) return;", new="if (!anchored && !toRunId) return;", cli=True),
 dict(name='H4_cli_socket_branch_drops_runId', file='src/cli/index.ts',
      old="(w) => ({ id: w.id, name: w.name ?? '', runId: w.runId }),", new="(w) => ({ id: w.id, name: w.name ?? '' }),", cli=True),
 dict(name='H5_cli_old_app_runId_defaults_to_self', file='src/cli/index.ts',
      old="runId: candidates.find((c) => c.id === id)?.runId ?? null };", new="runId: candidates.find((c) => c.id === id)?.runId ?? id };", cli=True),
 dict(name='H8_offline_runId_always_self', file='src/cli/index.ts',
      old="runId: nearestOrchestratorId(nodes.get(w.id as string)!, (id) => nodes.get(id)),", new="runId: w.id as string,", cli=True),
 dict(name='H9_server_resolveHandle_runId_self', file='src/main/workspaces.ts',
      old="runId: resolveWaveRunId(w) })),", new="runId: w.id })),", rig=True),
 dict(name='F2_direct_parent_to_topmost', file='src/main/wave-run-id.ts',
      old="const parent = ws.parentId ? lookup(ws.parentId) : undefined;", new="const parent = ws.parentId ? lookup(walkToRootId(ws, lookup)) : undefined;"),
 dict(name='F3a_probe_error_true', file='src/main/bus-run-anchor.ts',
      old="    } catch {\n      return false;\n    }\n  };\n}", new="    } catch {\n      return true;\n    }\n  };\n}"),
 dict(name='F3b_probe_nobus_true', file='src/main/bus-run-anchor.ts',
      old="return !!db && deps.getRun(db, id) !== null;", new="return !db || deps.getRun(db, id) !== null;"),
]
json.dump(M,open('/home/lmas/.orchestra/reviewer-a5-delta-work/mutants.json','w'),indent=1)
print(len(M),'mutants')
