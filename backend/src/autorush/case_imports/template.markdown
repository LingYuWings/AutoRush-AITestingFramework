# AutoRush 专用演示回归

## 用例：网页填写与提交
- 执行端：web

### 说明
验证演示页的输入和提交反馈。

### 前置条件
- 本地演示服务已启动，并已在测试计划中配置允许访问的地址。

### 步骤
| 序号 | 操作 | 预期结果 |
| --- | --- | --- |
| 1 | 打开 /fixture.html | 显示 AutoRush Web Fixture |
| 2 | 在 Search 中输入 Import-001 并点击 Submit | 显示 Submitted: Import-001 |

### 后置步骤
| 序号 | 操作 | 预期结果 | 始终执行 |
| --- | --- | --- | --- |
| 1 | 点击 Reset | 显示 Waiting | 是 |

## 用例：手机演示首页
- 执行端：android

### 前置条件
- 测试计划已选择配对手机和 com.autorush.fixture。

### 步骤
| 序号 | 操作 | 预期结果 |
| --- | --- | --- |
| 1 | 打开 AutoRush Test Fixture | 显示 Waiting |

## 用例：桌面演示提交
- 执行端：desktop

### 前置条件
- 专用桌面演示窗口已打开，并已在测试计划中选定该窗口。

### 步骤
1. 操作：在姓名输入框填写 Import-Desktop 并点击提交
   预期：显示 Import-Desktop 提交成功

## 用例：API 健康检查
- 执行端：api

### 前置条件
- 测试计划已配置本地 API 演示服务的基础地址。

### 步骤
| 序号 | 操作 | 预期结果 |
| --- | --- | --- |
| 1 | 请求健康检查 | HTTP 状态码为 200 |

```autorush-api
{
  "order": 1,
  "request": {
    "name": "健康检查",
    "method": "GET",
    "url": "/health",
    "assertions": [
      {"kind": "status_code", "expected": 200}
    ]
  }
}
```
