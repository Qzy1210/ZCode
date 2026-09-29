/* expo-secure-store 的测试替身:验证脚本会注入自己的 credentialStore,
 * 真实实现属于原生模块无法在 Node 里加载,这里只保证模块能解析。 */
export async function getItemAsync(): Promise<string | null> {
  return null;
}

export async function setItemAsync(): Promise<void> {}

export async function deleteItemAsync(): Promise<void> {}
