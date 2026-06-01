# koishi-plugin-disaster-warning

[![npm](https://img.shields.io/npm/v/koishi-plugin-disaster-warning?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-disaster-warning)

Koishi 灾害预警插件，支持多数据源（地震、海啸、气象预警）实时推送。
本插件移植自 [astrbot_plugin_disaster_warning](https://github.com/DBJD-CR/astrbot_plugin_disaster_warning)，感谢原作者的开源贡献。

## ✨ 功能特性

### 🌍 多数据源支持
插件支持多个可自由选择启用的细粒度数据源，覆盖全球主要地震监测机构：
- **中国地震网地震预警 (FAN Studio / Wolfx)** - 实时地震预警信息。
- **台湾中央气象署强震即时警报 (FAN Studio / Wolfx)** - 台湾地区地震预警。
- **日本气象厅紧急地震速报 (P2P / Wolfx / FAN Studio)** - 日本紧急地震速报。
- **中国地震台网地震测定 (FAN Studio / Wolfx)** - 正式地震测定信息。
- **日本气象厅地震情报 (P2P / Wolfx)** - 详细地震情报。
- **USGS地震测定 (FAN Studio)** - 美国地质调查局地震信息。
- **Global Quake服务器** - 全球地震测站实时计算推送，精度有限。
- **中国气象局气象预警 (FAN Studio)** - 气象灾害预警。
- **自然资源部海啸预警中心 (FAN Studio)** - 海啸预警信息。
- **日本气象厅海啸预报 (P2P)** - 日本海啸预报信息。

### 🎯 智能推送控制
- **阈值过滤** - 根据震级、烈度、震度设置推送阈值。
- **频率控制** - 智能推送逻辑，避免短时间内刷屏。
- **首报推送保证** - 确保预警信息首次下达时总是推送。
- **震中地区过滤** - 地震类事件会按震中地名与经纬度过滤，关闭全球地区后，CENC 等数据源发布的海外地震不会再误推送。
- **最终报保证** - 确保最终报总是推送。

### 🔁 事件去重功能
插件具备基础的事件去重功能，防止同一地震被同一个数据源重复推送。

## 🚀 安装与使用

### 安装

```bash
npm install koishi-plugin-disaster-warning
```

或者在 Koishi 插件市场搜索 `disaster-warning` 安装。

### 配置

安装完成后，在 Koishi 控制台的「插件配置」页面进行配置：

1. **启用插件**：确保 `enabled` 为 `true`。
2. **目标群组**：在 `target_groups` 中添加需要推送预警消息的群号。
3. **灾害类型**：在 `data_types` 中选择是否接收地震预警、地震信息、海啸预警、气象预警。
4. **接收地区**：在 `regions` 中选择中国大陆、台湾、日本或全球。数据源连接会依据此项自动开启，地震类事件还会按震中位置再次过滤。
5. **过滤器配置**：在 `filter` 中设置震级、烈度、震度阈值，避免过多打扰。

### 地区过滤说明

`regions` 同时控制数据源连接与地震震中地区过滤。例如仅开启中国大陆和台湾、关闭日本与全球时，插件仍可连接 CENC/CWA 等相关数据源，但智利、印尼等不在已开启地区内的地震会被丢弃，不会因为由 CENC 发布就被推送。

当前震中识别优先使用地名关键词，其次使用经纬度范围；无法识别且带有非空地名的地震默认视为全球事件。

## 📋 使用命令

插件提供以下指令：

- `disaster` - 查看插件帮助信息
- `disaster.test` - 发送一条测试预警消息，用于验证配置是否生效
- `disaster.history` - 查看最近的地震记录 (数据来源：CENC)

## 📄 许可证

本项目采用 [AGPL-3.0](./LICENSE) 许可证。
