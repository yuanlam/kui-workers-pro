<template>
  <div v-if="activeTab === 'settings'" class="kui-settings-page">
    <template v-if="role === 'admin'">
      <section class="kui-settings-card">
        <header class="kui-settings-heading">
          <span class="kui-settings-icon">⚙️</span>
          <div><h3>KUI 代理系统参数</h3><p>管理控制台名称与管理员订阅安全策略。</p></div>
        </header>
        <div class="kui-settings-system-grid">
          <form class="kui-settings-field" @submit.prevent="saveSiteTitle">
            <label for="kui-site-title">控制面板全局名称</label>
            <div class="kui-settings-inline">
              <input id="kui-site-title" v-model.trim="siteTitleInput" maxlength="100" placeholder="Cluster Gateway" @input="markSiteTitleDirty">
              <button class="kui-button kui-button-primary" :disabled="siteTitleSaving">{{ siteTitleSaving ? '保存中…' : '保存名称' }}</button>
            </div>
          </form>
          <form class="kui-settings-field" @submit.prevent="saveRulesetMirror">
            <label for="kui-ruleset-mirror">分流规则集镜像前缀</label>
            <div class="kui-settings-inline">
              <input id="kui-ruleset-mirror" v-model="rulesetMirror.input" type="url" pattern="https://.+" maxlength="512" placeholder="留空使用原始规则源" :disabled="rulesetMirror.saving" @input="rulesetMirror.dirty = true">
              <button class="kui-button kui-button-primary" :disabled="!rulesetMirror.dirty || rulesetMirror.saving">{{ rulesetMirror.saving ? '保存中…' : '保存镜像' }}</button>
            </div>
          </form>
          <div class="kui-settings-field">
            <label>管理员订阅安全</label>
            <div class="kui-settings-security-actions">
              <button type="button" class="kui-settings-danger-button" :disabled="subTokenResetting" @click="resetMySubLink">{{ subTokenResetting ? '重置中…' : '重置订阅令牌' }}</button>
              <label class="kui-settings-switch" :class="{ 'is-active': probeSys.subscription_protection === 'true' }">
                <input v-model="probeSys.subscription_protection" type="checkbox" true-value="true" false-value="false" :disabled="subscriptionProtectionSaving" @change="saveSubscriptionProtection">
                <span>订阅保护{{ probeSys.subscription_protection === 'true' ? '已开启' : '已关闭' }}</span>
              </label>
            </div>
            <small>开启后订阅接口返回 404，并停止在线更新。</small>
          </div>
        </div>
      </section>

      <section class="kui-settings-card kui-probe-dashboard-settings" @input="markProbeSettingsDirty">
        <header class="kui-settings-heading">
          <span class="kui-settings-icon">⚡</span>
          <div><h3>Realtime 状态频率策略</h3><p>状态变化仍会立即推送，以下频率仅控制常规状态更新。</p></div>
        </header>
        <div class="kui-settings-grid kui-settings-grid-three">
          <div class="kui-settings-field"><label for="realtime-admin">管理员后台（秒）</label><input id="realtime-admin" v-model.number="probeSys.realtime_admin_interval" type="number" min="5" max="60" step="1"><small>5–60 秒，默认 5 秒</small></div>
          <div class="kui-settings-field"><label for="realtime-public">公开探针（秒）</label><input id="realtime-public" v-model.number="probeSys.realtime_public_interval" type="number" min="10" max="120" step="1"><small>10–120 秒，默认 10 秒</small></div>
          <div class="kui-settings-field"><label for="realtime-idle">无人查看（秒）</label><input id="realtime-idle" v-model.number="probeSys.realtime_idle_interval" type="number" min="30" max="600" step="1"><small>30–600 秒，默认 30 秒</small></div>
        </div>
        <p class="kui-settings-note">公开探针频率不得快于管理员后台，空闲频率不得快于公开探针。</p>
      </section>

      <section class="kui-settings-card kui-probe-server-settings">
        <header class="kui-settings-heading">
          <span class="kui-settings-icon">💻</span>
          <div><h3>探针服务端管理</h3><p>已接入的 VPS 会自动同步到这里，仅需维护前台展示信息。</p></div>
          <span class="kui-settings-count">{{ adminProbeServers.length }} 台</span>
        </header>
        <div class="kui-settings-table">
          <table>
            <thead><tr><th>节点名称</th><th>分组</th><th>状态</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-if="adminProbeServers.length === 0"><td colspan="4" class="kui-settings-empty">暂无探针，请在“服务器与节点”页面接入 VPS</td></tr>
              <tr v-for="s in adminProbeServers" :key="s.id">
                <td><strong>{{ s.name }}</strong><span v-if="s.is_hidden === 'true'" class="kui-settings-hidden">隐藏</span></td>
                <td>{{ s.server_group || '默认分组' }}</td>
                <td><span class="kui-settings-status" :class="isOnline(s.last_updated, s.realtime_state) ? 'is-online' : 'is-offline'">{{ isOnline(s.last_updated, s.realtime_state) ? '在线' : '离线' }}</span></td>
                <td><div class="kui-settings-row-actions"><button type="button" @click="openProbeEditModal(s)">编辑</button><button type="button" class="is-danger" @click="deleteProbeNode(s.id)">删除</button></div></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section class="kui-settings-card" @input="markProbeSettingsDirty">
        <header class="kui-settings-heading kui-settings-heading-action">
          <span class="kui-settings-icon">📊</span>
          <div><h3>探针大盘外观与设置</h3><p>配置公开展示、测速节点、通知和自定义内容。</p></div>
          <button type="button" class="kui-button kui-button-ghost kui-settings-pull" :disabled="githubNodesPulling" @click="pullGithubNodes">{{ githubNodesPulling ? '拉取中…' : '更新主题与测速库' }}</button>
        </header>
        <div class="kui-settings-columns">
          <div class="kui-settings-stack">
            <h4>外观与内容</h4>
            <div class="kui-settings-field"><label for="probe-title">大盘展示标题</label><input id="probe-title" v-model.trim="probeSys.site_title" maxlength="100"></div>
            <div class="kui-settings-field"><label for="probe-theme">前端主题风格</label><select id="probe-theme" v-model="probeSys.theme"><option v-for="t in availableThemes" :key="t.id" :value="t.id">{{ t.name }}</option></select></div>
            <div v-if="probeSys.theme === 'theme6' || hasCustomCssFlag" class="kui-settings-field"><label for="probe-css">自定义 CSS</label><textarea id="probe-css" v-model="probeSys.custom_css" rows="4" spellcheck="false"></textarea></div>
            <div class="kui-settings-field"><label for="probe-bg">背景图片 URL</label><input id="probe-bg" v-model.trim="probeSys.custom_bg" type="url" placeholder="清空后恢复纯色"></div>
            <div class="kui-settings-field"><label for="probe-report">客户端上报间隔（秒）</label><input id="probe-report" v-model.number="probeSys.report_interval" type="number" min="1" max="3600" step="1"><small>允许范围 1–3600 秒</small></div>
          </div>

          <div class="kui-settings-stack">
            <h4>前台展示控制</h4>
            <div class="kui-settings-toggle-grid">
              <label class="kui-settings-toggle"><input v-model="probeSys.auto_reset_traffic" type="checkbox" true-value="true" false-value="false"><span><b>流量按期重置</b><small>按各节点重置日自动清零</small></span></label>
              <label class="kui-settings-toggle"><input v-model="probeSys.is_public" type="checkbox" true-value="true" false-value="false"><span><b>公开访问</b><small>关闭后必须登录查看</small></span></label>
              <label class="kui-settings-toggle"><input v-model="probeSys.show_price" type="checkbox" true-value="true" false-value="false"><span><b>机器价格</b></span></label>
              <label class="kui-settings-toggle"><input v-model="probeSys.show_expire" type="checkbox" true-value="true" false-value="false"><span><b>到期时间</b></span></label>
              <label class="kui-settings-toggle"><input v-model="probeSys.show_bw" type="checkbox" true-value="true" false-value="false"><span><b>带宽徽章</b></span></label>
              <label class="kui-settings-toggle"><input v-model="probeSys.show_tf" type="checkbox" true-value="true" false-value="false"><span><b>流量配额</b></span></label>
            </div>
            <label class="kui-settings-toggle kui-settings-toggle-wide"><input v-model="probeSys.enable_popup" type="checkbox" true-value="true" false-value="false"><span><b>首页公告弹窗</b><small>按纯文本安全显示</small></span></label>
            <div v-if="probeSys.enable_popup === 'true'" class="kui-settings-field"><label for="probe-popup">公告内容</label><textarea id="probe-popup" v-model="probeSys.popup_content" rows="4" placeholder="请输入公告内容"></textarea></div>

            <h4>三网测速节点</h4>
            <div class="kui-settings-grid kui-settings-grid-three">
              <div class="kui-settings-field"><label for="ping-ct">电信 CT</label><select id="ping-ct" v-model="probeSys.ping_node_ct"><option value="default">默认轮询</option><option v-for="n in pingNodes.ct" :key="n.host" :value="n.host">{{ n.name }}</option></select></div>
              <div class="kui-settings-field"><label for="ping-cu">联通 CU</label><select id="ping-cu" v-model="probeSys.ping_node_cu"><option value="default">默认轮询</option><option v-for="n in pingNodes.cu" :key="n.host" :value="n.host">{{ n.name }}</option></select></div>
              <div class="kui-settings-field"><label for="ping-cm">移动 CM</label><select id="ping-cm" v-model="probeSys.ping_node_cm"><option value="default">默认轮询</option><option v-for="n in pingNodes.cm" :key="n.host" :value="n.host">{{ n.name }}</option></select></div>
            </div>

            <h4>Telegram 管理与告警</h4>
            <div class="kui-settings-grid kui-settings-grid-three kui-settings-telegram-grid">
              <div class="kui-settings-field"><label for="tg-notify">告警状态</label><select id="tg-notify" v-model="probeSys.tg_notify"><option value="false">关闭告警</option><option value="true">开启掉线告警</option></select></div>
              <div class="kui-settings-field"><label for="tg-token">Bot Token</label><input id="tg-token" v-model.trim="probeSys.tg_bot_token" autocomplete="off" placeholder="用于机器人命令"></div>
              <div class="kui-settings-field"><label for="tg-chat">管理员 Chat ID</label><input id="tg-chat" v-model.trim="probeSys.tg_chat_id" autocomplete="off"></div>
            </div>
          </div>
        </div>
        <div class="kui-settings-save" :class="{ 'is-dirty': probeSettingsDirty }"><span>{{ probeSettingsDirty ? '有尚未应用的修改' : '当前配置已同步' }}</span><button type="button" :disabled="probeSettingsSaving || !probeSettingsDirty" @click="saveProbeSettings">{{ probeSettingsSaving ? '应用中…' : '应用探针配置' }}</button></div>
      </section>
    </template>

    <template v-else-if="role === 'user'">
      <section class="kui-settings-card">
        <header class="kui-settings-heading"><span class="kui-settings-icon">🔑</span><div><h3>账号安全</h3><p>修改后当前登录会话将自动退出。</p></div></header>
        <form class="kui-settings-field kui-settings-user-form" @submit.prevent="updateUserPassword">
          <label for="user-new-password">新登录密码</label>
          <div class="kui-settings-inline"><input id="user-new-password" v-model="userNewPassword" type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="至少 12 位"><button class="kui-button kui-button-primary" :disabled="passwordSaving">{{ passwordSaving ? '修改中…' : '确认修改' }}</button></div>
        </form>
      </section>
      <section class="kui-settings-card">
        <header class="kui-settings-heading"><span class="kui-settings-icon">🔄</span><div><h3>订阅连接重置</h3><p>令牌重置后旧订阅链接立即失效，不影响登录密码。</p></div></header>
        <button type="button" class="kui-settings-danger-button" :disabled="subTokenResetting" @click="resetMySubLink">{{ subTokenResetting ? '重置中…' : '重置并吊销旧订阅' }}</button>
      </section>
    </template>
  </div>
</template>

<script>
import { inject } from 'vue';
import { KUI_KEY } from '../app/context.js';

export default {
  setup() {
    return inject(KUI_KEY);
  },
};
</script>
