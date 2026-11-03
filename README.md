# DSH 余额与本轮用量插件

在 DeepSeek Harness 的对话输入框下方显示账户余额、最近已完成轮次的 Token 用量及 Token 费用预估。支持新建对话和已有对话。

- 包标识：`@local/dsh-account-balance`
- 插件版本：`1.1.0`
- 适用宿主：Windows DeepSeek Harness **`0.2.1-rc.5`**；其他版本尚未验证。
- 项目与下载：[GitHub 仓库](https://github.com/Leslie-Orange/dsh-account-balance) · [v1.1.0 下载目录](https://github.com/Leslie-Orange/dsh-account-balance/tree/main/dist/v1.1.0)

## 安装

先安装上述宿主版本。在 Harness 的“插件”页打开“添加插件”，粘贴以下发布包完整链接并确认安装：

```text
https://raw.githubusercontent.com/Leslie-Orange/dsh-account-balance/main/dist/v1.1.0/local-dsh-account-balance-1.1.0.tgz
```

也可先从版本下载目录下载 `local-dsh-account-balance-1.1.0.tgz`，在“添加插件”中输入该文件的绝对本地路径。桌面安装界面说明见 [官方插件管理器文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-plugin-manager/README.md)。

如果已经安装并可以执行 `dsh` CLI，可选择在下载目录的 PowerShell 中运行：

```powershell
dsh plugin --profile desktop add .\local-dsh-account-balance-1.1.0.tgz
```

CLI 也支持直接从公开安装包地址安装：

```powershell
dsh plugin --profile desktop add https://raw.githubusercontent.com/Leslie-Orange/dsh-account-balance/main/dist/v1.1.0/local-dsh-account-balance-1.1.0.tgz
```

执行后从应用菜单完整退出 Harness，再重新打开，让插件资源重新加载。仅关闭窗口到托盘可能不会重启应用。进入对话页后，输入框下方会出现余额和本轮统计；首次读取时余额可暂时显示 `—`。

版本化下载目录同时提供 [源码 ZIP](https://raw.githubusercontent.com/Leslie-Orange/dsh-account-balance/main/dist/v1.1.0/dsh-account-balance-1.1.0-source.zip) 和 [SHA-256 校验清单](https://raw.githubusercontent.com/Leslie-Orange/dsh-account-balance/main/dist/v1.1.0/SHA256SUMS.txt)。PowerShell 可用 `Get-FileHash .\local-dsh-account-balance-1.1.0.tgz -Algorithm SHA256` 核对。

## 通过自定义插件索引发现

DSH 当前没有官方中央插件商店，使用者自行添加和选择索引源。本项目提供的索引地址为：

```text
https://raw.githubusercontent.com/Leslie-Orange/dsh-account-balance/main/index.json
```

在 Harness 中打开“插件”，启用实验性的“自定义插件索引”，进入“发现”并添加上述索引源，再安装本插件。也可使用上方 `.tgz` 命令直接安装。

插件发布方式遵循 [DSH 官方发布说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)；自定义索引操作和格式见 [官方插件索引指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/plugin-market.zh.md)。

## 使用与数据口径

- 余额通过宿主已有的 `ctx.remote.account.getBalance` 接口读取，沿用宿主登录状态，无需额外填写 API Key；插件不读取或保存登录凭据。
- 对话页脚可见时每 30 秒自动刷新余额；用量变化后等待 5 秒再次读取，相邻自动请求至少间隔 8 秒。页面隐藏或没有对话页脚时暂停。
- 人民币与美元分开显示。未登录、首次读取失败或尚未读取时显示 `—`；后续读取失败会保留上次成功金额，悬停可查看更新时间和失败提示。
- 本轮统计来自宿主最近已完成轮次的 `turn-tail` 记录，包含该轮模型调用与工具往返。思考 Token 已包含在输出中，不重复加总；记录缺失或不完整时显示 `—`。
- 费用按代码内置的 [DeepSeek 官方人民币价格表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)预估，只对可识别的官方 Flash/Pro 单一模型路由显示闲时至高峰范围。费率可能调整，插件不会自动更新价格表。
- Token 费用预估不含网页搜索等工具收费，也不代表赠送余额抵扣后的现金支出；实际扣费以平台账单为准。未知模型、混合路由、冲突记录及早于当前价格生效时点的历史记录不套用当前估价。

## 源码与验证

源码包只含插件运行文件、文档、隔离测试与打包脚本。无需安装额外依赖，在仓库根目录执行：

```powershell
npm test
npm run check
```

15 项隔离回归测试覆盖余额格式、账户切换与退出竞态、失败恢复、刷新节流、页面可见性、轮次统计、费用估算和组件清理。测试使用宿主与浏览器桩，不等同于所有环境的真机验证。

在 Windows PowerShell 中重新生成安装包、源码包与校验清单：

```powershell
.\tools\package-release.ps1
```

默认输出到仓库同级目录；可以通过 `-OutputDirectory` 指定输出目录。`npm pack` 仅打包 `package.json` 中 `files` 白名单列出的运行文件与文档，不包含测试或打包脚本。没有安装生命周期脚本，也不要求 npm 注册表发布。

## 权利说明

本项目公开提供下载和本人安装使用，**保留全部权利，不授予修改、再分发或再许可的额外权限**。公开可下载不表示采用开放源代码许可证。详见 [LICENSE](LICENSE)。
