# v1.1.0

适用宿主：Windows DeepSeek Harness `0.2.1-rc.5`。

- 在新建和已有对话的输入框下方显示账户余额。
- 显示最近已完成轮次的 Token 总量及可识别 DeepSeek 路由的 Token 费用预估范围。
- 自动刷新余额，处理账户切换、退出登录、页面可见性、读取失败与组件卸载。
- 保留 `@local/dsh-account-balance` 包标识及对应客户端模块、Cordis patch 配置。

安装命令与费用口径见 [README](README.md)。源码公开可下载，本人可安装使用；额外修改与再分发权限不予授予，见 [LICENSE](LICENSE)。

发布验证：导出源码的 15 项隔离回归测试及 JavaScript 语法检查。自动化测试使用桩环境，不作为真机验证声明。

本版本通过公开仓库的 [dist/v1.1.0 下载目录](https://github.com/Leslie-Orange/dsh-account-balance/tree/main/dist/v1.1.0) 提供安装包、源码包、校验清单和中文说明：

- [安装包](https://raw.githubusercontent.com/Leslie-Orange/dsh-account-balance/main/dist/v1.1.0/local-dsh-account-balance-1.1.0.tgz)
- [源码 ZIP](https://raw.githubusercontent.com/Leslie-Orange/dsh-account-balance/main/dist/v1.1.0/dsh-account-balance-1.1.0-source.zip)
- [SHA-256 校验清单](https://raw.githubusercontent.com/Leslie-Orange/dsh-account-balance/main/dist/v1.1.0/SHA256SUMS.txt)

自定义插件索引位于仓库根目录 `index.json`，Git source 固定到实际源码提交。
