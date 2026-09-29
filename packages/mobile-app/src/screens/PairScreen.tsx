import { useCallback, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { parsePairingQrPayload, type PairingQrPayload } from "../pairingQr";
import { theme } from "../theme";

export function PairScreen({ onPaired }: { onPaired: (qr: PairingQrPayload) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [manualUrl, setManualUrl] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const handleScanned = useCallback(
    ({ data }: { data: string }) => {
      if (scanned) return;
      const qr = parsePairingQrPayload(data);
      if (!qr) return; // 非配对二维码,继续扫描。
      setScanned(true);
      onPaired(qr);
    },
    [onPaired, scanned],
  );

  const handleManualConnect = useCallback(() => {
    const qr = parsePairingQrPayload(manualUrl);
    if (!qr) {
      setManualError("链接无效:请粘贴桌面端生成的完整二维码链接");
      return;
    }
    setManualError(null);
    onPaired(qr);
  }, [manualUrl, onPaired]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>ZCode</Text>
        <Text style={styles.subtitle}>扫描桌面端「移动端远程控制」二维码完成配对</Text>
      </View>

      <View style={styles.cameraShell}>
        {permission?.granted ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scanned ? undefined : handleScanned}
          />
        ) : (
          <View style={styles.permissionBox}>
            <Text style={styles.permissionText}>需要相机权限用于扫码</Text>
            <Pressable style={styles.primaryButton} onPress={() => void requestPermission()}>
              <Text style={styles.primaryButtonText}>授权相机</Text>
            </Pressable>
          </View>
        )}
      </View>

      <View style={styles.manualSection}>
        <Text style={styles.manualLabel}>或粘贴二维码链接</Text>
        <TextInput
          style={styles.input}
          value={manualUrl}
          onChangeText={setManualUrl}
          placeholder="http://…/remote?sid=…"
          placeholderTextColor={theme.foregroundSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          multiline={false}
        />
        {manualError ? <Text style={styles.errorText}>{manualError}</Text> : null}
        <Pressable style={styles.primaryButton} onPress={handleManualConnect}>
          <Text style={styles.primaryButtonText}>连接</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: theme.background, padding: 16 },
  header: { paddingTop: 24, paddingBottom: 16 },
  title: { color: theme.primary, fontSize: 28, fontWeight: "600" },
  subtitle: { color: theme.foregroundSubtle, fontSize: 13, marginTop: 6 },
  cameraShell: {
    aspectRatio: 1,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    backgroundColor: theme.panel,
  },
  camera: { flex: 1 },
  permissionBox: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  permissionText: { color: theme.foregroundSubtle, fontSize: 13 },
  manualSection: { paddingTop: 20, gap: 8 },
  manualLabel: { color: theme.foregroundSubtle, fontSize: 13 },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.foreground,
    backgroundColor: theme.panel,
    fontSize: 13,
  },
  errorText: { color: theme.destructive, fontSize: 12 },
  primaryButton: {
    backgroundColor: theme.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  primaryButtonText: { color: theme.primaryForeground, fontSize: 15, fontWeight: "600" },
});
