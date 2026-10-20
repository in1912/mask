<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api.js';

const catalog = ref(null);
const cfg = ref(null);
const fixedText = ref('');
const err = ref('');
const okMsg = ref('');
const busy = ref(false);

const previewIn = ref('客户是杭州云梯智造有限公司，联系手机 13812345678，合同金额 45万元，接口地址 http://internal.corp/api/v2');
const previewOut = ref(null);

const CAT_ORDER = ['pii', 'ent', 'tech', 'meta'];
const CAT_ZH = { pii: '个人隐私信息', ent: '企业业务敏感信息', tech: '技术/系统敏感信息', meta: '文档隐藏元数据' };
const METHOD_ZH = { regex: '正则', anchor: '锚定', luhn: '校验', heuristic: '启发式', dict: '词典', meta: '元数据' };

async function load() {
  const out = await api('/rules/meta');
  catalog.value = out.catalog;
  cfg.value = out.cfg;
  fixedText.value = (out.cfg.fixed || []).map((f) => (typeof f === 'string' ? f : f.term)).join('\n');
}
function isOn(k) { return cfg.value.types[k] !== false; }
function toggleRule(k) { cfg.value.types[k] = isOn(k) ? false : true; }

async function save() {
  busy.value = true; err.value = ''; okMsg.value = '';
  try {
    const fixed = fixedText.value.split('\n').map((s) => s.trim()).filter(Boolean);
    const out = await api('/rules/config', {
      method: 'PUT',
      body: { ...cfg.value, fixed }
    });
    cfg.value = out.cfg;
    okMsg.value = '已保存';
  } catch (e) { err.value = e.message; }
  busy.value = false;
}

async function runPreview() {
  err.value = ''; okMsg.value = '';
  try {
    previewOut.value = await api('/rules/preview', { method: 'POST', body: { text: previewIn.value } });
  } catch (e) { err.value = e.message; }
}

onMounted(load);
</script>

<template>
  <div v-if="cfg" style="max-width:980px">
    <div class="page-title">规则配置</div>

    <div class="card" style="margin-bottom:14px">
      <div style="display:flex;flex-wrap:wrap;gap:22px;align-items:center">
        <label style="display:flex;gap:8px;align-items:center">
          <span class="switch"><input type="checkbox" v-model="cfg.enabled" :true-value="1" :false-value="0"><i></i></span>
          <b>脱敏总开关</b>
          <span class="mut" style="font-size:12px">关闭后系统会如实提示未脱敏</span>
        </label>
        <label style="display:flex;gap:8px;align-items:center">
          <span class="switch"><input type="checkbox" v-model="cfg.amount_on" :true-value="1" :false-value="0"><i></i></span>
          <b>语境金额脱敏</b>
          <span class="mut" style="font-size:12px">报价/金额/回款/薪资</span>
        </label>
        <label style="display:flex;gap:8px;align-items:center">
          <span class="switch"><input type="checkbox" v-model="cfg.mask_numbers" :true-value="1" :false-value="0"><i></i></span>
          <b>裸数字脱敏</b>
        </label>
        <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
          <b>编码风格</b>
          <label v-for="s in [['A','混合语义码 [公司A7]'],['B','纯序号 [公司1]'],['C','随机码 ORG-7K2M9']]" :key="s[0]"
            style="display:flex;gap:4px;align-items:center;font-size:13px">
            <input type="radio" :value="s[0]" v-model="cfg.code_style">{{ s[1] }}
          </label>
        </div>
      </div>
      <div class="card" style="margin-top:12px;background:var(--accent-weak);border-color:transparent">
        <b>数字脱敏的影响（先想清楚再开）</b>
        <p class="mut" style="font-size:12.5px;margin-top:4px">
          结构化号码（身份证 / 手机 / 银行卡 / 订单号 / 工号）无论开关如何都会脱敏；
          「语境金额」开启时报价、合同金额、回款、薪资会被替换成占位码——AI 将<b>无法做算术、统计、比价</b>，只能定性讨论；
          「裸数字」默认关闭：开启后正文里 ≥3 位的数字（年份除外）都会替换，AI 对一切数量、比例、日期计算都将失效，但脱敏最彻底。
        </p>
      </div>
    </div>

    <div class="card" v-for="cat in CAT_ORDER" :key="cat" style="margin-bottom:14px">
      <h3 style="font-size:15px;margin-bottom:10px">{{ CAT_ZH[cat] }}（{{ catalog[cat].rules.length }} 条）</h3>
      <div class="tbl-scroll">
        <table class="tbl">
          <thead><tr><th style="width:36px"></th><th>规则</th><th>识别方式</th><th>说明</th></tr></thead>
          <tbody>
            <tr v-for="rule in catalog[cat].rules" :key="rule.key">
              <td v-if="rule.method !== 'meta'"><span class="switch"><input type="checkbox" :checked="isOn(rule.key)" @change="toggleRule(rule.key)"><i></i></span></td>
              <td v-else class="mut">—</td>
              <td>{{ rule.zh }}</td>
              <td><span class="tag">{{ METHOD_ZH[rule.method] || rule.method }}</span></td>
              <td class="mut" style="font-size:12px">{{ rule.hint || '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card" style="margin-bottom:14px">
      <h3 style="font-size:15px;margin-bottom:8px">固定关键词（每行一个，最高优先级，无条件替换）</h3>
      <textarea v-model="fixedText" rows="4" style="width:100%" placeholder="例如：&#10;某某内部代号&#10;董事长姓名"></textarea>
    </div>

    <p v-if="err" class="err">{{ err }}</p>
    <p v-else-if="okMsg" style="color:var(--ok)">{{ okMsg }}</p>
    <button class="btn primary" :disabled="busy" @click="save">保存配置</button>

    <div class="card" style="margin-top:20px">
      <h3 style="font-size:15px;margin-bottom:8px">试运行</h3>
      <textarea v-model="previewIn" rows="4" style="width:100%"></textarea>
      <button class="btn" style="margin-top:8px" @click="runPreview">试运行脱敏</button>
      <div v-if="previewOut" style="margin-top:12px">
        <p v-if="previewOut.skipped" class="tag warn">{{ previewOut.reason }}</p>
        <template v-else>
          <div style="background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap">{{ previewOut.masked }}</div>
          <p class="mut" style="margin-top:6px">共替换 {{ previewOut.count }} 项（已记入脱敏历史，可去「脱敏历史」复核）</p>
          <table class="tbl map-tbl" style="margin-top:6px">
            <thead><tr><th>原文</th><th>占位码</th></tr></thead>
            <tbody><tr v-for="e in previewOut.mapping" :key="e.term"><td>{{ e.term }}</td><td><code class="code-chip">{{ e.style === 'C' ? e.code : '[' + e.code + ']' }}</code></td></tr></tbody>
          </table>
        </template>
      </div>
    </div>
  </div>
</template>
