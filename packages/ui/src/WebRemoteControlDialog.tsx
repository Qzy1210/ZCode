import { memo, useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { MOBILE_PAIRING_TTL_MS, type BotProvider } from "@zcode/shared";
import { Bot as BotIcon, MonitorSmartphone, XIcon } from "lucide-react";
import { BotsDialog } from "@/BotsDialog.js";
import {
  MobilePairingQrSection,
  PairedDevicesSection,
  type MobilePairingDeviceSummary,
} from "@/WebRemoteControlSections.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getBotProviderRegionTagLabelId } from "@/botsUi.js";

type RemoteControlBotProvider = Extract<
  BotProvider,
  "weixin" | "feishu" | "lark" | "telegram"
>;

const REMOTE_CONTROL_BOT_ENTRIES: Array<{
  provider: RemoteControlBotProvider;
}> = [
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

export const WebRemoteControlDialog = memo(function WebRemoteControlDialogComponent({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEntryProvider, setBotEntryProvider] =
    useState<RemoteControlBotProvider | null>(null);
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [qrMode, setQrMode] = useState<"lan" | "relay" | null>(null);
  const [qrStopped, setQrStopped] = useState(false);
  const [qrIssuedAt, setQrIssuedAt] = useState<number | null>(null);
  const [qrExpired, setQrExpired] = useState(false);
  const [devices, setDevices] = useState<MobilePairingDeviceSummary[]>([]);

  const generateQr = useCallback(
    async (regenerate: boolean) => {
      if (!platform.mobilePairingCreateQr) {
        setQrError("当前环境不支持移动端配对");
        return;
      }
      setQrLoading(true);
      setQrError(null);
      try {
        // regenerate=false 时复用未过期二维码:重开弹窗不顶掉已连接的手机。
        const result = await platform.mobilePairingCreateQr({ regenerate });
        if ("error" in result) {
          setQrError(result.error);
          setQrImageUrl(null);
          setQrMode(null);
          return;
        }
        setQrMode(result.mode);
        // 记录签发时间:二维码在 TTL 后失效,弹层据此提示"已过期",避免扫到过期码。
        const issuedAt = Number(new URL(result.url).searchParams.get("t"));
        setQrIssuedAt(Number.isFinite(issuedAt) && issuedAt > 0 ? issuedAt : Date.now());
        setQrExpired(false);
        const dataUrl = await QRCode.toDataURL(result.url, { margin: 1, width: 220 });
        setQrImageUrl(dataUrl);
        setQrStopped(false);
        logger.info("[WebRemoteControlDialog] 移动端配对二维码已生成", {
          mode: result.mode,
          regenerate,
        });
      } catch (error) {
        setQrError(error instanceof Error ? error.message : String(error));
        setQrImageUrl(null);
      } finally {
        setQrLoading(false);
      }
    },
    [platform],
  );

  const handleStopQr = useCallback(async () => {
    if (!platform.mobilePairingStop) return;
    setQrLoading(true);
    setQrError(null);
    try {
      await platform.mobilePairingStop();
      setQrStopped(true);
      setQrExpired(false);
      setQrImageUrl(null);
      setQrMode(null);
      logger.info("[WebRemoteControlDialog] 移动端远控已停止");
    } catch (error) {
      setQrError(error instanceof Error ? error.message : String(error));
    } finally {
      setQrLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    // 打开弹窗:复用未过期的二维码;关闭弹窗不停服务——手机连接只在
    // 桌面应用退出或用户显式"停止远控"时断开。
    if (!open) return;
    void generateQr(false);
    void platform.mobilePairingListDevices?.().then(setDevices).catch(() => {});
  }, [open, generateQr, platform]);

  const handleRevokeDevice = useCallback(
    async (deviceId: string) => {
      const revoked = await platform.mobilePairingRevokeDevice?.(deviceId);
      if (revoked) {
        setDevices((current) => current.filter((device) => device.deviceId !== deviceId));
        logger.info("[WebRemoteControlDialog] 已吊销设备凭证");
      }
    },
    [platform],
  );

  useEffect(() => {
    // 当前二维码到期即切换到"已过期"态,防止屏幕上残留的二维码被扫后认证失败。
    if (qrImageUrl === null || qrIssuedAt === null) return;
    const remaining = qrIssuedAt + MOBILE_PAIRING_TTL_MS - Date.now();
    if (remaining <= 0) {
      setQrExpired(true);
      return;
    }
    const timer = setTimeout(() => setQrExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [qrImageUrl, qrIssuedAt]);

  const handleOpenBotEntry = (provider: RemoteControlBotProvider) => {
    setBotEntryProvider(provider);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bot Channel 配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      provider,
    });
  };

  const handleOpenBotsDialog = () => {
    setBotEntryProvider(null);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bots 总配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[calc(100vh-6rem)] max-w-lg gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Bugfix: 这个弹窗会贴近桌面窗口顶部显示，默认 close 在 Electron drag 区里容易点不中。
            // 这里改成显式点击关闭，并把按钮本身标成 no-drag，保证右上角关闭动作能稳定命中。
            // Bugfix: 远控弹层内可点击控件之前没有显式 pointer cursor，桌面端 hover 时不像可操作元素。
            // 这里仅给启用态补手指指针，禁用态仍沿用 Button 的 disabled 交互语义。
            className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
            onClick={() => onOpenChange(false)}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
          <div className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5">
            <DialogHeader className="space-y-2 pr-8">
              <div className="flex items-center gap-2">
                <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-surface text-primary">
                  <MonitorSmartphone className="size-5" />
                </div>
                <div className="space-y-1">
                  <DialogTitle>
                    {intl.formatMessage({ id: "webRemoteControl.title" })}
                  </DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "webRemoteControl.description" })}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="mt-5 grid gap-4">
              <MobilePairingQrSection
                qrLoading={qrLoading}
                qrImageUrl={qrImageUrl}
                qrExpired={qrExpired}
                qrStopped={qrStopped}
                qrError={qrError}
                qrMode={qrMode}
                onRegenerate={() => void generateQr(true)}
                onStop={() => void handleStopQr()}
              />
              <PairedDevicesSection
                devices={devices}
                onRevoke={(deviceId) => void handleRevokeDevice(deviceId)}
              />
              <section className="flex min-h-[360px] flex-col rounded-xl border border-border bg-card p-4">
                <div className="mb-4 flex items-start gap-2">
                  <BotIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
                  <div className="min-w-0 space-y-1">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.title",
                      })}
                    </div>
                    <p className="text-ui-base/relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.description",
                      })}
                    </p>
                  </div>
                </div>
                <div className="grid min-h-0 flex-1 gap-3">
                  {REMOTE_CONTROL_BOT_ENTRIES.map((entry) => {
                    const regionTagLabelId = getBotProviderRegionTagLabelId(
                      entry.provider,
                    );

                    return (
                      <button
                        key={entry.provider}
                        type="button"
                        className="flex min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-transparent bg-surface px-3 py-3 text-left transition-colors hover:border-input-border-focused hover:bg-surface-hover focus-visible:border-input-border-focused"
                        onClick={() => handleOpenBotEntry(entry.provider)}
                      >
                        {/* Bugfix: 远控 Bot Channel 入口原来用通用 lucide 图标，用户无法一眼区分微信、飞书和 Telegram。
                            这里直接复用 BotsDialog 的渠道 logo，不再额外包裹容器，保证品牌图标本身作为视觉识别。 */}
                        <ProviderIcon
                          provider={entry.provider}
                          className="size-12 shrink-0"
                        />
                        <span className="min-w-0 flex-1 space-y-1">
                          <span className="flex min-w-0 items-center gap-1.5 text-ui-base font-medium text-foreground">
                            <span className="min-w-0 truncate">
                              {intl.formatMessage({
                                id: `webRemoteControl.botChannel.${entry.provider}.title`,
                              })}
                            </span>
                            {regionTagLabelId ? (
                              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                                {intl.formatMessage({ id: regionTagLabelId })}
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-ui-base/relaxed text-foreground-subtle">
                            {intl.formatMessage({
                              id: `webRemoteControl.botChannel.${entry.provider}.description`,
                            })}
                          </span>
                          <span className="block text-ui-base font-medium text-primary">
                            {intl.formatMessage({
                              id: "webRemoteControl.botChannel.configure",
                            })}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-full justify-center gap-2 enabled:cursor-pointer"
                    onClick={handleOpenBotsDialog}
                  >
                    <BotIcon className="size-3.5" />
                    {intl.formatMessage({
                      id: "webRemoteControl.botChannel.manageBots",
                    })}
                  </Button>
                </div>
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <BotsDialog
        open={botsDialogOpen}
        onOpenChange={setBotsDialogOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        entryProvider={botEntryProvider}
      />
    </>
  );
});
