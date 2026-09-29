import { registerRootComponent } from "expo";

import App from "./App";
import { ensureRuntimePolyfills } from "./src/polyfills";

// polyfill 必须在任何 @zcode/shared 调用(配对 proof 计算)之前注入。
ensureRuntimePolyfills();
registerRootComponent(App);
