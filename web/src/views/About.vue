<script setup>
</script>

<template>
  <div style="max-width:820px">
    <div class="page-title">脱敏原理</div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-bottom:8px">为什么是「先脱敏，再上云」</h3>
      <p class="mut">把原文直接发给外部 AI，等于把客户名单、身份证、接口密钥一次性交给第三方。面具的做法是在你的电脑上先完成规则替换：AI 收到的只有占位码，回复回来后再按对照表复原。原文与对照表<b>永远不离开本机</b>。</p>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-bottom:8px">四条设计红线</h3>
      <ol class="mut" style="padding-left:20px;display:grid;gap:6px">
        <li><b style="color:var(--fg)">识别阶段纯规则</b>：引擎不调 AI、不联网，正则 / 锚定 / 校验 / 词典四种手段，本地毫秒级完成。</li>
        <li><b style="color:var(--fg)">同一实体同码</b>：同一会话内「杭州云梯智造有限公司」永远是同一个码，AI 不会把它当成两家公司。</li>
        <li><b style="color:var(--fg)">长词优先</b>：按词长降序替换，防止「张三丰」被「张三」吃掉一半。</li>
        <li><b style="color:var(--fg)">绝不假装脱敏</b>：总开关关闭时如实返回「未脱敏」，不悄悄放行。</li>
      </ol>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-bottom:8px">占位码为什么长这样</h3>
      <p class="mut" style="margin-bottom:6px">三种编码风格可在「脱敏引擎 → 内置引擎参数配置」切换：</p>
      <ul class="mut" style="padding-left:20px;display:grid;gap:6px">
        <li><b style="color:var(--fg)">A 混合语义码（默认）</b>：<code class="code-chip">[公司A7]</code> —— 保留类别语义，AI 能顺着句子理解「某公司」，语义连贯性最好。</li>
        <li><b style="color:var(--fg)">B 纯序号</b>：<code class="code-chip">[公司1]</code> —— 最短，多实体长文里 AI 需要自己数着记。</li>
        <li><b style="color:var(--fg)">C 随机码</b>：<code class="code-chip">ORG-7K2M9</code> —— 看不出任何语义，保密性最强，但 AI 更容易把实体当成 ID 字段，连贯性稍差。</li>
      </ul>
      <p class="mut" style="margin-top:8px">每次脱敏发送都会附上系统指令：要求 AI 原样保留占位码、不翻译不展开。回文到达后自动按对照表复原，并做<b>二次复核</b>：残留未复原的代码、对照表中未出现的原文都会在界面标出。</p>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="margin-bottom:8px">诚实的边界（当前版本）</h3>
      <ul class="mut" style="padding-left:20px;display:grid;gap:6px">
        <li>人名只认<b>称谓</b>（王总/周工）和<b>角色锚定</b>（参会人员：/代表签字：）这两类明确语境——按姓氏猜名字会把「伍拾捌万元整」「万店掌系统」拆成假人名，所以不做；没有锚点的孤立姓名会漏，请加进「固定关键词」。地址、公司名同样是启发式，可能漏报或误报。</li>
        <li>数字一旦脱敏，AI 无法做算术与统计（「脱敏引擎 → 内置引擎参数配置」页有专门说明）。</li>
        <li>文件脱敏、分享链接、Agent 协同在 P1 版本提供；当前版本支持对话与附件（txt/docx）。</li>
        <li>识别不了的东西就是识别不了——系统不会为了「看起来全」而把整段文字打码。</li>
      </ul>
    </div>
  </div>
</template>
