<template>
  <Teleport to="body">
    <div class="profile-mask" :class="{ 'is-closing': closing }" @click.self="close" @keydown.stop="handleKey" @animationend.self="finishClose">
      <section ref="surface" class="profile-editor profile-panel" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title" tabindex="-1" :aria-busy="loading || saving">
        <header><div><p class="eyebrow">YOUR ACCOUNT / 酷狗账号</p><h2 id="profile-editor-title">编辑资料</h2></div>
          <button type="button" aria-label="关闭资料编辑" :disabled="saving || blocked" @click="close">×</button></header>
        <AppNotice :message="error" title="账号资料" type="error" />
        <p class="profile-note">保存后同步修改酷狗账号的资料。此资料接口使用未加密连接，请勿填写敏感信息。</p>
        <p v-if="loading" class="profile-loading" role="status"><span class="profile-spinner" aria-hidden="true"></span>正在读取账号资料…</p>
        <button v-else-if="!loaded" type="button" class="profile-retry" :disabled="blocked" @click="load">重新读取资料</button>
        <form v-else @submit.prevent="save">
          <label>昵称<input ref="nicknameInput" v-model="draft.nickname" required maxlength="50" autocomplete="off" :disabled="saving || blocked" /></label>
          <label>个性签名<textarea v-model="draft.signature" maxlength="200" rows="3" :disabled="saving || blocked"></textarea></label>
          <div class="profile-fields">
            <fieldset class="profile-sex"><legend>性别</legend><label v-for="option in sexOptions" :key="option.value"><input v-model="draft.sex" type="radio" name="profile-sex" :value="option.value" :disabled="saving || blocked" />{{ option.label }}</label></fieldset>
            <label>生日<input v-model="draft.birthday" type="date" :disabled="saving || blocked" /></label>
          </div>
          <footer><button type="button" :disabled="saving || blocked" @click="close">取消</button>
            <button type="submit" class="profile-save" :disabled="saving || blocked || !changed || !draft.nickname.trim()">
              <span v-if="saving" class="profile-spinner" aria-hidden="true"></span>{{ saving ? '正在保存…' : '保存到酷狗' }}
            </button></footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<script>
import { getUserProfile, updateUserProfile } from '../../api/profile.js'

const sessions = new WeakMap()
const fields = ['nickname', 'signature', 'sex', 'birthday']

export default {
  name: 'ProfileEditor',
  props: { userInfo: { type: Object, required: true }, blocked: Boolean },
  emits: ['close', 'updated'],
  data() {
    return { draft: { nickname: '', signature: '', sex: '', birthday: '' }, original: null,
      loading: false, loaded: false, saving: false, closing: false, error: '',
      sexOptions: [{ value: '2', label: '保密' }, { value: '1', label: '男' }, { value: '0', label: '女' }] }
  },
  computed: {
    changed() { return this.original && fields.some(field => this.draft[field] !== this.original[field]) }
  },
  created() {
    sessions.set(this, { userId: localStorage.getItem('kugou_userid'), token: localStorage.getItem('kugou_token'),
      controller: new AbortController(), disposed: false, closeTimer: null })
  },
  mounted() {
    const session = sessions.get(this)
    session.previousFocus = document.activeElement
    session.appRoot = document.getElementById('app')
    session.previousInert = session.appRoot?.inert
    if (session.appRoot) session.appRoot.inert = true
    this.$refs.surface.focus({ preventScroll: true })
    this.load()
  },
  beforeUnmount() {
    const session = sessions.get(this)
    session.disposed = true
    session.controller.abort()
    clearTimeout(session.closeTimer)
    if (session.appRoot) session.appRoot.inert = session.previousInert
    if (session.previousFocus?.isConnected && !session.previousFocus.closest?.('[inert], [hidden]')) session.previousFocus.focus({ preventScroll: true })
    sessions.delete(this)
  },
  methods: {
    handleKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); return }
      if (event.key !== 'Tab') return
      const panel = this.$refs.surface
      const controls = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)')]
      if (!controls.length) { event.preventDefault(); panel.focus(); return }
      if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === panel)) {
        event.preventDefault(); controls.at(-1).focus()
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault(); controls[0].focus()
      }
    },
    /** Reject completions belonging to a previous account or a closed editor without exposing credentials in UI state. */
    isCurrent() {
      const session = sessions.get(this)
      return session && !session.disposed && !session.controller.signal.aborted &&
        session.userId === localStorage.getItem('kugou_userid') && session.token === localStorage.getItem('kugou_token')
    },
    async load() {
      if (this.loading || this.saving || this.blocked || this.closing) return
      this.loading = true
      this.error = ''
      try {
        const profile = await getUserProfile(this.userInfo, { signal: sessions.get(this).controller.signal })
        if (!this.isCurrent()) return
        this.original = Object.fromEntries(fields.map(field => [field, profile[field]]))
        this.draft = { ...this.original }
        this.loaded = true
        await this.$nextTick()
        if (this.isCurrent()) this.$refs.nicknameInput?.focus({ preventScroll: true })
      } catch (error) { if (this.isCurrent()) this.error = error.message || '读取资料失败，请重试' }
      finally { if (this.isCurrent()) this.loading = false }
    },
    /** Keep failed drafts intact; shared account validation prevents late saves from updating another account's header. */
    async save() {
      if (!this.loaded || !this.changed || this.saving || this.blocked || this.closing || !this.isCurrent()) return
      const patch = Object.fromEntries(fields.filter(field => this.draft[field] !== this.original[field]).map(field => [field, this.draft[field]]))
      this.saving = true
      this.error = ''
      try {
        await updateUserProfile(patch, { signal: sessions.get(this).controller.signal })
        if (!this.isCurrent()) return
        this.$emit('updated', { userid: sessions.get(this).userId, username: this.draft.nickname.trim() })
        this.saving = false
        this.close()
      } catch (error) { if (this.isCurrent()) this.error = error.message || '保存资料失败，请重试' }
      finally { if (this.isCurrent()) this.saving = false }
    },
    close() {
      if (this.saving || this.blocked || this.closing) return
      this.closing = true
      sessions.get(this).controller.abort()
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.hidden) { this.finishClose(); return }
      sessions.get(this).closeTimer = setTimeout(() => this.finishClose(), 180)
    },
    finishClose() {
      if (!this.closing) return
      clearTimeout(sessions.get(this)?.closeTimer)
      this.$emit('close')
    }
  }
}
</script>

<style scoped>
.profile-mask { position: fixed; inset: 0; z-index: 15000; display: grid; place-items: center; padding: 20px; background: #0006; backdrop-filter: blur(8px); animation: profile-backdrop-in .2s ease; }
.profile-editor { box-sizing: border-box; width: min(540px, 100%); max-height: calc(100dvh - 40px); border: 1px solid var(--color-border); border-radius: 26px; background: var(--color-background-light); color: var(--color-text); box-shadow: 0 24px 80px #0004; overflow-y: auto; animation: profile-in .2s var(--ui-motion-ease); }
.profile-mask.is-closing { animation: profile-backdrop-out .16s ease-in forwards; pointer-events: none; }
.profile-mask.is-closing .profile-editor { animation: profile-out .16s ease-in forwards; }
.profile-panel { padding: 28px; }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h2 { margin: 5px 0 0; font-size: 26px; letter-spacing: -.04em; }
.eyebrow { margin: 0; color: var(--color-text-secondary); font-size: 10px; letter-spacing: .14em; }
button { min-height: 38px; padding: 8px 14px; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-background-lighter); color: inherit; cursor: pointer; }
header button { font-size: 24px; line-height: 1; }
button:disabled, input:disabled, textarea:disabled { opacity: .55; cursor: default; }
.profile-note { margin: 20px 0; color: var(--color-text-secondary); font-size: 12px; line-height: 1.7; }
form { display: grid; gap: 18px; }
label { display: grid; min-width: 0; gap: 8px; font-size: 12px; color: var(--color-text-secondary); }
input:not([type=radio]), textarea { box-sizing: border-box; width: 100%; min-width: 0; padding: 11px 12px; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-background-lighter); color: var(--color-text); font: inherit; }
textarea { resize: vertical; min-height: 80px; }
input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.profile-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.profile-sex { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; margin: 0; padding: 0; border: 0; }
.profile-sex legend { margin-bottom: 12px; color: var(--color-text-secondary); font-size: 12px; }
.profile-sex label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.profile-sex input { accent-color: var(--color-primary); }
footer { justify-content: flex-end; padding-top: 6px; }
.profile-save { background: var(--color-primary); color: var(--color-on-primary); border-color: transparent; }
.profile-loading, .profile-save { display: flex; align-items: center; gap: 8px; }
.profile-loading { color: var(--color-text-secondary); font-size: 13px; }
.profile-spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: profile-spin .7s linear infinite; }
@keyframes profile-spin { to { transform: rotate(360deg); } }
@keyframes profile-in { from { opacity: 0; transform: translateY(12px) scale(.98); } to { opacity: 1; transform: none; } }
@keyframes profile-out { to { opacity: 0; transform: translateY(8px) scale(.98); } }
@keyframes profile-backdrop-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes profile-backdrop-out { to { opacity: 0; } }
@media (max-width: 420px) { .profile-panel { padding: 22px; } .profile-fields { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .profile-mask, .profile-editor, .profile-mask.is-closing, .profile-mask.is-closing .profile-editor, .profile-spinner { animation: none; } }
</style>
