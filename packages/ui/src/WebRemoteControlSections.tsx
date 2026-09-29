/* WebRemoteControlDialog 的展示区块:配对二维码与已配对设备列表。
 * 从弹窗主体拆出以控制单文件行数;区块本身不持有弹窗状态,只做展示与回调上报。 */
import { Power, QrCode, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface MobilePairingDeviceSummary {
  deviceId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number;
}

export function MobilePairingQrSection({
  qrLoading,
  qrImageUrl,
  qrExpired,
  qrStopped,
  qrError,
  qrMode,
  onRegenerate,
  onStop,
}: {
  qrLoading: boolean;
  qrImageUrl: string | null;
  qrExpired: boolean;
  qrStopped: boolean;
  qrError: string | null;
  qrMode: "lan" | "relay" | null;
  onRegenerate: () => void;
  onStop: () => void;
}) {
  const { intl } = useZCodeIntl();
  const regenerateButton = (labelId: string) => (
    <Button type="button" variant="outline" size="sm" onClick={onRegenerate}>
      <RefreshCw className="size-3.5" />
      {intl.formatMessage({ id: labelId })}
    </Button>
  );

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-4 flex items-start gap-2">
        <QrCode className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 space-y-1">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "webRemoteControl.qr.title" })}
          </div>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.qr.description" })}
          </p>
        </div>
      </div>
      <div className="flex min-h-[260px] flex-1 items-center justify-center rounded-lg bg-surface p-4">
        {qrLoading ? (
          <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
        ) : qrImageUrl && !qrExpired ? (
          <img
            src={qrImageUrl}
            alt="mobile pairing qr"
            className="size-[220px] rounded-lg bg-white p-1"
          />
        ) : qrImageUrl && qrExpired ? (
          <div className="max-w-xs space-y-2 text-center">
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "webRemoteControl.qr.expiredHint" })}
            </p>
            {regenerateButton("webRemoteControl.qr.regenerate")}
          </div>
        ) : qrStopped ? (
          <div className="max-w-xs space-y-2 text-center">
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "webRemoteControl.qr.stoppedHint" })}
            </p>
            {regenerateButton("webRemoteControl.qr.regenerate")}
          </div>
        ) : (
          <div className="max-w-xs space-y-2 text-center">
            <p className="text-ui-sm text-foreground-subtle">{qrError ?? "二维码不可用"}</p>
            {regenerateButton("webRemoteControl.qr.retry")}
          </div>
        )}
      </div>
      {qrImageUrl && !qrExpired ? (
        <div className="mt-3 flex items-center justify-between gap-2">
          <p className="min-w-0 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({
              id:
                qrMode === "relay"
                  ? "webRemoteControl.qr.hint.relay"
                  : "webRemoteControl.qr.hint.lan",
            })}
          </p>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={qrLoading} onClick={onRegenerate}>
              <RefreshCw className="size-3.5" />
              {intl.formatMessage({ id: "webRemoteControl.qr.regenerate" })}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={qrLoading} onClick={onStop}>
              <Power className="size-3.5" />
              {intl.formatMessage({ id: "webRemoteControl.qr.stop" })}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

export function PairedDevicesSection({
  devices,
  onRevoke,
}: {
  devices: MobilePairingDeviceSummary[];
  onRevoke: (deviceId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-3 space-y-1">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "webRemoteControl.devices.title" })}
        </div>
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.devices.description" })}
        </p>
      </div>
      {devices.length === 0 ? (
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.devices.empty" })}
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {devices.map((device) => (
            <div
              key={device.deviceId}
              className="flex items-center justify-between gap-2 rounded-lg bg-surface px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-ui-sm text-foreground">{device.name}</div>
                <div className="text-ui-xs text-foreground-subtle">
                  {new Date(device.lastSeenAt).toLocaleString()}
                </div>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => onRevoke(device.deviceId)}>
                {intl.formatMessage({ id: "webRemoteControl.devices.revoke" })}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
