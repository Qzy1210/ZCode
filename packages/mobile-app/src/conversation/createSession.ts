/* 新建任务:发 v4 createSession,拿到 sessionId 后由调用方进入会话屏。
 *
 * 与桌面语义一致(两段式):这里不带 firstInput —— 草稿会话不落库,
 * 用户真正发出第一条消息后才会出现在任务列表里。
 */
import type { RemoteServiceAccess } from "@zcode/client";

import { createAgentCommandClient, isCommandAccepted } from "./agentCommandClient";
import type { AgentCommandWorkspace } from "./agentCommandClient";

export type CreateSessionResult =
  | { ok: true; sessionId: string }
  | { ok: false; message: string };

export async function createSessionTask(params: {
  services: RemoteServiceAccess;
  clientId: string;
  workspace: AgentCommandWorkspace;
}): Promise<CreateSessionResult> {
  const commands = createAgentCommandClient(params);
  try {
    await commands.ensureReady();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  try {
    const ack = await commands.send(
      "createSession",
      // workspaceId 是身份键:与仓库 workspaceIdentity 规则一致(identity ?? path)。
      { workspaceId: params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath },
      null,
    );
    if (!isCommandAccepted(ack)) {
      return { ok: false, message: ack.message ?? ack.reasonCode ?? `创建被拒绝(${ack.status})` };
    }
    const sessionId =
      ack.result?.type === "createSession" ? ack.result.sessionId : undefined;
    if (!sessionId) return { ok: false, message: "已接受但未返回会话 ID" };
    return { ok: true, sessionId };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
