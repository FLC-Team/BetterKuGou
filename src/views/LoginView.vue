<template>
  <div class="login-container">
    <div class="login-box">
      <h1 class="login-title">欢迎登录 BetterKuGou</h1>
      
      <!-- 登录方式切换标签 -->
      <div class="login-tabs">
        <button 
          v-for="tab in tabs" 
          :key="tab.id"
          :class="['tab-btn', { active: currentTab === tab.id }]"
          :disabled="loginFeedback.kind === 'success'"
          :aria-pressed="currentTab === tab.id"
          @click="currentTab = tab.id"
        >
          {{ tab.name }}
        </button>
      </div>

      <!-- 登录表单区域 -->
      <div class="login-form">
        <!-- 手机号登录 -->
        <div v-if="currentTab === 'phone'" class="form-content" :aria-busy="phoneLoading">
          <div class="form-group">
            <label class="form-label">手机号</label>
            <input 
              v-model="phoneForm.phone"
              type="tel" 
              class="input" 
              placeholder="请输入手机号"
              maxlength="11"
            />
          </div>
          <div class="form-group">
            <label class="form-label">验证码</label>
            <div class="captcha-input">
              <input 
                v-model="phoneForm.captcha"
                type="text" 
                class="input" 
                placeholder="请输入验证码"
                maxlength="6"
              />
              <button 
                class="btn btn-secondary captcha-btn"
                :disabled="captchaCountdown > 0 || captchaLoading || loginFeedback.kind === 'success'"
                :aria-busy="captchaLoading"
                @click="sendCaptcha"
              >
                <span v-if="captchaLoading" class="loading-spinner inline-spinner" aria-hidden="true"></span>
                {{ captchaLoading ? '发送中…' : captchaCountdown > 0 ? `${captchaCountdown}s` : '获取验证码' }}
              </button>
            </div>
          </div>
          <button type="button" class="btn btn-primary login-submit" :disabled="phoneLoading || loginFeedback.kind === 'success'" :aria-busy="phoneLoading" @click="handlePhoneLogin">
            <span v-if="phoneLoading" class="loading-spinner inline-spinner" aria-hidden="true"></span>
            {{ phoneLoading ? '正在登录…' : loginFeedback.kind === 'success' ? '登录成功' : '登录' }}
          </button>
        </div>

        <!-- 账号登录 -->
        <div v-if="currentTab === 'account'" class="form-content" :aria-busy="accountLoading">
          <div class="form-group">
            <label class="form-label">账号</label>
            <input 
              v-model="accountForm.username"
              type="text" 
              class="input" 
              placeholder="请输入账号/邮箱"
            />
          </div>
          <div class="form-group">
            <label class="form-label">密码</label>
            <input 
              v-model="accountForm.password"
              type="password" 
              class="input" 
              placeholder="请输入密码"
            />
          </div>
          <button type="button" class="btn btn-primary login-submit" :disabled="accountLoading || loginFeedback.kind === 'success'" :aria-busy="accountLoading" @click="handleAccountLogin">
            <span v-if="accountLoading" class="loading-spinner inline-spinner" aria-hidden="true"></span>
            {{ accountLoading ? '正在登录…' : loginFeedback.kind === 'success' ? '登录成功' : '登录' }}
          </button>
        </div>

        <!-- 扫码登录 -->
        <div v-if="currentTab === 'qrcode'" class="form-content qrcode-content">
          <div class="qrcode-box" :class="{ 'qrcode-error': qrcodeStatus === 'error' || qrcodeStatus === 'expired' }">
            <Transition name="ui-fade" mode="out-in" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')">
            <!-- 二维码图片 -->
            <div v-if="qrcodeUrl && qrcodeStatus === 'waiting'" class="qrcode-image">
              <img :src="qrcodeUrl" alt="二维码" />
            </div>
            
            <!-- 加载中 -->
            <div v-else-if="qrcodeLoading" class="qrcode-loading">
              <span class="loading-spinner" role="status" aria-label="正在生成二维码"></span>
              <p>正在生成二维码...</p>
            </div>
            
            <!-- 加载失败 -->
            <button type="button" v-else-if="qrcodeStatus === 'error'" class="qrcode-error-msg" @click="retryQRCode">
              <svg viewBox="0 0 1024 1024" width="48" height="48" fill="currentColor">
                <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
                <path d="M464 336a48 48 0 1096 0 48 48 0 10-96 0zm32 120h64v288h-64z"/>
              </svg>
              <p class="error-title">加载失败</p>
              <p class="error-subtitle">点击重新加载</p>
            </button>
            
            <!-- 二维码过期 -->
            <div v-else-if="qrcodeStatus === 'expired'" class="qrcode-expired-msg">
              <svg viewBox="0 0 1024 1024" width="48" height="48" fill="currentColor">
                <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372z"/>
                <path d="M686.7 638.6L544.1 535.5V288c0-4.4-3.6-8-8-8h-48c-4.4 0-8 3.6-8 8v275.4c0 2.6 1.2 5 3.3 6.5l165.4 120.6c3.6 2.6 8.6 1.8 11.2-1.7l28.6-39c2.6-3.7 1.8-8.7-1.9-11.2z"/>
              </svg>
              <p class="expired-title">二维码已过期</p>
              <p class="expired-subtitle">正在自动刷新...</p>
            </div>
            
            <!-- 已扫描，等待确认 -->
            <div v-else-if="qrcodeStatus === 'scanned'" class="qrcode-scanned-msg">
              <div class="qrcode-image-small">
                <img :src="qrcodeUrl" alt="二维码" />
              </div>
              <div class="scan-success-icon">
                <svg viewBox="0 0 1024 1024" width="48" height="48" fill="currentColor" class="success-icon">
                  <path d="M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm193.5 301.7l-210.6 292a31.8 31.8 0 01-51.7 0L318.5 484.9c-3.8-5.3 0-12.7 6.5-12.7h46.9c10.2 0 19.9 4.9 25.9 13.3l71.2 98.8 157.2-218c6-8.3 15.6-13.3 25.9-13.3H699c6.5 0 10.3 7.4 6.5 12.7z"/>
                </svg>
              </div>
              <p class="scanned-user">{{ scannedUsername || '用户' }} 已扫描</p>
              <p class="scanned-tip">请在手机上确认登录</p>
            </div>
            <div v-else-if="qrcodeStatus === 'success'" class="qrcode-scanned-msg" role="status"><span class="success-icon">✓</span><p>登录成功</p></div>
            </Transition>
          </div>
          
          <!-- 提示文字 -->
          <p v-if="qrcodeStatus === 'waiting'" class="qrcode-tip">请使用酷狗音乐 App 扫码登录</p>
        </div>
      </div>

      <div class="login-feedback-region" aria-live="polite" aria-atomic="true">
        <Transition name="ui-fade" mode="out-in" @before-leave="$event.setAttribute('inert', '')" @before-enter="$event.removeAttribute('inert')" @leave-cancelled="$event.removeAttribute('inert')"><p v-if="loginFeedback.text" :key="loginFeedback.kind + loginFeedback.text" class="login-feedback" :class="loginFeedback.kind" :role="loginFeedback.kind === 'error' ? 'alert' : 'status'">{{ loginFeedback.text }}</p></Transition>
      </div>

      <!-- 返回按钮 -->
      <button class="btn-back" @click="handleBack">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
          <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script>
import { logger } from '../utils/logger.js'

import { 
  sendCaptcha as sendCaptchaAPI,
  loginByPhone,
  loginByAccount,
  getQRCodeKey,
  createQRCode,
  checkQRCodeStatus as checkQRCodeStatusAPI,
  saveLoginInfo
} from '../api/auth.js'

export default {
  name: 'LoginView',
  data() {
    return {
      currentTab: 'phone',
      tabs: [
        { id: 'phone', name: '手机号登录' },
        { id: 'account', name: '账号登录' },
        { id: 'qrcode', name: '扫码登录' }
      ],
      // 手机号登录表单
      phoneForm: {
        phone: '',
        captcha: ''
      },
      // 账号登录表单
      accountForm: {
        username: '',
        password: ''
      },
      // 二维码登录
      qrcodeUrl: '',
      qrcodeKey: '',
      qrcodeStatus: '', // 'waiting', 'scanned', 'success', 'expired', 'error'
      qrcodeTimer: null,
      qrcodeRefreshTimer: null,
      qrcodeGeneration: 0,
      qrcodeLoading: false,
      qrcodeError: null,
      scannedUsername: '', // 扫描用户的名称
      // 验证码倒计时
      captchaCountdown: 0,
      captchaTimer: null,
      captchaLoading: false,
      // 加载状态
      phoneLoading: false,
      accountLoading: false,
      disposed: false,
      loginGeneration: 0,
      loginFeedback: { text: '', kind: 'info' }
    }
  },
  mounted() {
    // 如果默认是扫码登录，自动生成二维码
    if (this.currentTab === 'qrcode') {
      this.generateQRCode()
    }
  },
  beforeUnmount() {
    this.disposed = true
    this.loginGeneration += 1
    this.stopQRCodePolling()
    if (this.captchaTimer) {
      clearInterval(this.captchaTimer)
      this.captchaTimer = null
    }
  },
  watch: {
    currentTab(newTab) {
      this.loginFeedback = { text: '', kind: 'info' }
      this.loginGeneration += 1
      this.phoneLoading = false
      this.accountLoading = false
      this.captchaLoading = false
      this.stopQRCodePolling()
      this.qrcodeUrl = ''
      this.qrcodeKey = ''
      this.scannedUsername = ''
      if (newTab === 'qrcode') {
        this.generateQRCode()
      }
    }
  },
  methods: {
    setFeedback(text, kind = 'error') {
      this.loginFeedback = { text: String(text || '操作失败，请重试'), kind }
    },
    /** 认证立即落盘；先刷新成功状态，再沿原事件出口导航。 */
    async completeLogin(userData) {
      saveLoginInfo(userData)
      this.setFeedback('登录成功，正在打开音乐…', 'success')
      await this.$nextTick()
      this.$emit('loginSuccess', userData)
      this.$emit('back')
    },
    // 错误对象可能包含密码、验证码和请求头，只记录诊断所需的状态。
    logLoginFailure(message, error) {
      logger.error('LoginView', message, {
        name: error?.name,
        code: error?.code,
        status: error?.response?.status
      })
    },
    isCurrentLogin(generation) {
      return !this.disposed && generation === this.loginGeneration
    },
    // 发送验证码
    async sendCaptcha() {
      if (!this.phoneForm.phone) {
        this.setFeedback('请输入手机号')
        return
      }
      if (!/^1[3-9]\d{9}$/.test(this.phoneForm.phone)) {
        this.setFeedback('请输入正确的手机号')
        return
      }

      if (this.captchaCountdown > 0 || this.captchaLoading || this.disposed) return
      const generation = this.loginGeneration

      try {
        this.setFeedback('正在发送验证码…', 'info')
        this.captchaLoading = true
        const response = await sendCaptchaAPI(this.phoneForm.phone)
        if (!this.isCurrentLogin(generation)) return
        if (response.status !== 1) {
          this.setFeedback('验证码发送失败，请稍后重试')
          return
        }
        
        // 开始倒计时
        this.captchaCountdown = 60
        this.captchaTimer = setInterval(() => {
          this.captchaCountdown--
          if (this.captchaCountdown <= 0) {
            clearInterval(this.captchaTimer)
            this.captchaTimer = null
          }
        }, 1000)

        this.setFeedback('验证码已发送，请查看手机', 'info')
      } catch (error) {
        if (!this.isCurrentLogin(generation)) return
        this.logLoginFailure('发送验证码失败', error)
        this.setFeedback('发送验证码失败，请稍后重试')
      } finally {
        if (this.isCurrentLogin(generation)) this.captchaLoading = false
      }
    },

    // 手机号登录
    async handlePhoneLogin() {
      if (!this.phoneForm.phone || !this.phoneForm.captcha) {
        this.setFeedback('请填写完整信息')
        return
      }

      if (this.phoneLoading || this.disposed) return
      const generation = this.loginGeneration

      try {
        this.setFeedback('正在验证登录信息…', 'info')
        this.phoneLoading = true
        const response = await loginByPhone(
          this.phoneForm.phone,
          this.phoneForm.captcha
        )
        if (!this.isCurrentLogin(generation)) return
        
        // 检查响应状态
        if (response.status === 1 && response.data?.token) {
          await this.completeLogin(response.data)
        } else {
          this.setFeedback(response.error || '登录失败，请检查手机号和验证码')
        }
      } catch (error) {
        if (!this.isCurrentLogin(generation)) return
        this.logLoginFailure('手机号登录失败', error)
        this.setFeedback('登录失败，请稍后重试')
      } finally {
        if (this.isCurrentLogin(generation)) this.phoneLoading = false
      }
    },

    // 账号登录
    async handleAccountLogin() {
      if (!this.accountForm.username || !this.accountForm.password) {
        this.setFeedback('请填写完整信息')
        return
      }

      if (this.accountLoading || this.disposed) return
      const generation = this.loginGeneration

      try {
        this.setFeedback('正在验证登录信息…', 'info')
        this.accountLoading = true
        const response = await loginByAccount(
          this.accountForm.username,
          this.accountForm.password
        )
        if (!this.isCurrentLogin(generation)) return
        
        // 检查响应状态
        if (response.status === 1 && response.data?.token) {
          await this.completeLogin(response.data)
        } else {
          this.setFeedback(response.error || '登录失败，请检查用户名和密码')
        }
      } catch (error) {
        if (!this.isCurrentLogin(generation)) return
        this.logLoginFailure('账号登录失败', error)
        this.setFeedback('登录失败，请稍后重试')
      } finally {
        if (this.isCurrentLogin(generation)) this.accountLoading = false
      }
    },

    isCurrentQRCode(generation) {
      return !this.disposed && this.currentTab === 'qrcode' && generation === this.qrcodeGeneration
    },
    // 取消定时任务并使在途二维码响应失效。
    stopQRCodePolling() {
      this.qrcodeGeneration += 1
      if (this.qrcodeTimer) clearTimeout(this.qrcodeTimer)
      if (this.qrcodeRefreshTimer) clearTimeout(this.qrcodeRefreshTimer)
      this.qrcodeTimer = null
      this.qrcodeRefreshTimer = null
      this.qrcodeLoading = false
    },
    // 生成二维码；每次刷新使用独立代次，旧响应不能重启轮询。
    async generateQRCode() {
      if (this.disposed || this.currentTab !== 'qrcode') return
      this.stopQRCodePolling()
      const generation = this.qrcodeGeneration
      try {
        this.qrcodeLoading = true
        this.qrcodeError = null
        this.qrcodeStatus = ''
        
        // 1. 获取二维码 key
        const keyResponse = await getQRCodeKey('web')
        if (!this.isCurrentQRCode(generation)) return
        
        // 兼容多种返回格式
        let qrKey = null
        if (keyResponse.data?.qrcode) {
          qrKey = keyResponse.data.qrcode
        } else if (keyResponse.qrcode) {
          qrKey = keyResponse.qrcode
        } else if (keyResponse.data?.key) {
          qrKey = keyResponse.data.key
        } else if (keyResponse.key) {
          qrKey = keyResponse.key
        }
        
        if (!qrKey) {
          throw new Error('获取二维码 key 失败')
        }
        
        this.qrcodeKey = qrKey
        
        // 2. 生成二维码图片
        const qrResponse = await createQRCode(this.qrcodeKey, true)
        if (!this.isCurrentQRCode(generation)) return
        
        // 兼容多种返回格式
        let qrImage = null
        if (qrResponse.body?.data?.base64) {
          qrImage = qrResponse.body.data.base64
        } else if (qrResponse.data?.base64) {
          qrImage = qrResponse.data.base64
        } else if (qrResponse.data?.qrimg) {
          qrImage = qrResponse.data.qrimg
        } else if (qrResponse.qrimg) {
          qrImage = qrResponse.qrimg
        } else if (qrResponse.body?.data?.url) {
          qrImage = qrResponse.body.data.url
        } else if (qrResponse.data?.url) {
          qrImage = qrResponse.data.url
        }
        
        if (!qrImage) {
          throw new Error('生成二维码失败')
        }
        
        this.qrcodeUrl = qrImage
        this.qrcodeStatus = 'waiting'
        
        // 开始轮询检查扫码状态
        this.startQRCodePolling(generation)
      } catch (error) {
        if (!this.isCurrentQRCode(generation)) return
        this.logLoginFailure('生成二维码失败', error)
        this.qrcodeStatus = 'error'
        this.qrcodeError = '生成二维码失败，请稍后重试'
      } finally {
        if (this.isCurrentQRCode(generation)) this.qrcodeLoading = false
      }
    },

    // 重新加载二维码
    retryQRCode() {
      this.qrcodeStatus = ''
      this.qrcodeError = null
      this.qrcodeUrl = ''
      this.generateQRCode()
    },

    scheduleQRCodeRefresh(generation) {
      this.qrcodeStatus = 'expired'
      this.qrcodeTimer = null
      this.qrcodeRefreshTimer = setTimeout(() => {
        this.qrcodeRefreshTimer = null
        if (this.isCurrentQRCode(generation)) this.retryQRCode()
      }, 1000)
    },
    // 每次请求完成后才安排下一次轮询，避免慢请求重叠和重复登录。
    startQRCodePolling(generation = this.qrcodeGeneration) {
      if (this.qrcodeTimer) clearTimeout(this.qrcodeTimer)
      let pollCount = 0
      const maxPolls = 150 // 限制轮询次数，失败请求也计入。
      const qrKey = this.qrcodeKey
      const poll = async () => {
        this.qrcodeTimer = null
        if (!this.isCurrentQRCode(generation)) return
        pollCount++
        
        try {
          const response = await checkQRCodeStatusAPI(qrKey)
          if (!this.isCurrentQRCode(generation)) return
          
          // 兼容多种返回格式 - 提取状态码
          let status = null
          let userData = null
          
          // 优先检查 data.status
          if (response.data && response.data.status !== undefined) {
            status = response.data.status
            userData = response.data
          } 
          // 然后检查根级 status
          else if (response.status !== undefined && typeof response.status === 'number') {
            status = response.status
            userData = response
          }
          // 最后检查 body.data
          else if (response.body && response.body.data && response.body.data.status !== undefined) {
            status = response.body.data.status
            userData = response.body.data
          }
          
          if (status === null) {
            throw new Error('无法解析二维码状态码')
          }
          
          // 处理状态
          switch (Number(status)) {
            case 0:
              // 二维码过期 - 自动刷新
              this.scheduleQRCodeRefresh(generation)
              return
              
            case 1:
              // 等待扫码
              this.qrcodeStatus = 'waiting'
              this.scannedUsername = ''
              break
              
            case 2:
              // 待确认 - 显示扫描用户信息
              this.qrcodeStatus = 'scanned'
              this.scannedUsername = userData.username || userData.nickname || userData.name || '用户'
              break
              
            case 4:
              // 授权登录成功
              if (!userData?.token) throw new Error('登录响应缺少凭证')
              this.qrcodeStatus = 'success'
              this.stopQRCodePolling()
              await this.completeLogin(userData)
              return
              
            default:
              logger.warn('LoginView', '[轮询] 未知状态码:', status)
          }
          
        } catch (error) {
          if (!this.isCurrentQRCode(generation)) return
          this.logLoginFailure('检查二维码状态失败', error)
        }
        if (!this.isCurrentQRCode(generation)) return
        if (pollCount >= maxPolls) {
          this.scheduleQRCodeRefresh(generation)
          return
        }
        this.qrcodeTimer = setTimeout(poll, 2000)
      }
      this.qrcodeTimer = setTimeout(poll, 2000)
    },



    // 检查二维码扫码状态
    checkQRCodeStatus() {
      // 此方法已被 startQRCodePolling 替代
      this.startQRCodePolling()
    },

    // 返回主界面
    handleBack() {
      this.disposed = true
      this.loginGeneration += 1
      this.stopQRCodePolling()
      this.$emit('back')
    }
  }
}
</script>

<style scoped>
.login-container {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
}

.login-box {
  width: 450px;
  max-width: 90%;
  background: var(--color-background-light);
  border-radius: var(--radius-lg);
  padding: var(--spacing-xl);
  box-shadow: var(--shadow-lg);
  position: relative;
  border: 1px solid var(--color-border);
}

.login-title {
  font-size: var(--font-size-2xl);
  font-weight: 600;
  text-align: center;
  margin-bottom: var(--spacing-xl);
  color: var(--color-text);
}

.login-tabs {
  display: flex;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
}

.tab-btn {
  flex: 1;
  padding: var(--spacing-md);
  background: transparent;
  border: none;
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  font-family: var(--font-family);
  cursor: pointer;
  transition: all var(--transition-base);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}

.tab-btn:hover {
  color: var(--color-text);
  background: var(--color-background);
}

.tab-btn.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  font-weight: 600;
}

.login-form {
  min-height: 300px;
}

.form-content {
  animation: fadeIn var(--transition-base);
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.form-group {
  margin-bottom: var(--spacing-lg);
}

.form-label {
  display: block;
  margin-bottom: var(--spacing-sm);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.input {
  width: 100%;
  padding: var(--spacing-md);
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-family: var(--font-family);
  transition: all var(--transition-base);
}

.input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: var(--shadow-focus);
}

.input::placeholder {
  color: var(--color-text-tertiary);
}

.captcha-input {
  display: flex;
  gap: var(--spacing-sm);
}

.captcha-input .input {
  flex: 1;
}

.captcha-btn {
  min-width: 120px;
  white-space: nowrap;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-background-lighter);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: var(--font-family);
  cursor: pointer;
  transition: all var(--transition-base);
}

.captcha-btn:hover:not(:disabled) {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--text-white);
}

.captcha-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.login-submit {
  width: 100%;
  margin-top: var(--spacing-lg);
  padding: var(--spacing-md);
  background: var(--color-primary);
  border: none;
  border-radius: var(--radius-md);
  color: white;
  font-size: var(--font-size-base);
  font-family: var(--font-family);
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-base);
}

.login-submit:hover:not(:disabled) {
  background: var(--color-primary-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.login-submit:active:not(:disabled) {
  background: var(--color-primary-active);
  transform: translateY(0);
}

.login-submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* 扫码登录样式 */
.qrcode-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-lg) 0;
}

.qrcode-box {
  width: 220px;
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: white;
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  margin-bottom: var(--spacing-md);
  border: 2px solid var(--color-border);
  position: relative;
  overflow: hidden;
  transition: all var(--transition-base);
}

.qrcode-box.qrcode-error {
  border-color: var(--color-error);
}

.qrcode-image {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.qrcode-image :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.qrcode-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  color: var(--color-text-secondary);
}

.qrcode-loading p {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

/* 错误状态样式 */
.qrcode-error-msg {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
  transition: all var(--transition-base);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
}

.qrcode-error-msg:hover {
  background: var(--color-error-light);
}

.qrcode-error-msg svg {
  color: var(--color-error);
}

.error-title {
  color: var(--color-error);
  font-size: var(--font-size-base);
  font-weight: 600;
  margin: 0;
}

.error-subtitle {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  margin: 0;
}

/* 过期状态样式 */
.qrcode-expired-msg {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
}

.qrcode-expired-msg svg {
  color: var(--color-text-tertiary);
}

.expired-title {
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  font-weight: 600;
  margin: 0;
}

.expired-subtitle {
  color: var(--color-text-tertiary);
  font-size: var(--font-size-sm);
  margin: 0;
}

/* 已扫描状态样式 */
.qrcode-scanned-msg {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
  width: 100%;
}

.qrcode-image-small {
  width: 120px;
  height: 120px;
  opacity: 0.3;
  position: relative;
  background: white;
}

.qrcode-image-small :deep(img) {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.scan-success-icon {
  margin-top: -70px;
  margin-bottom: var(--spacing-sm);
  animation: scaleIn 0.3s ease-out;
}

.success-icon {
  color: var(--color-success);
}

@keyframes scaleIn {
  from {
    transform: scale(0);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.scanned-user {
  color: var(--color-text);
  font-size: var(--font-size-base);
  font-weight: 600;
  margin: 0;
  text-align: center;
}

.scanned-tip {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  margin: 0;
  text-align: center;
  white-space: pre-line;
}

.qrcode-tip {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-lg);
  text-align: center;
}

/* 刷新按钮 */
.btn-secondary {
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-background-lighter);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: var(--font-family);
  cursor: pointer;
  transition: all var(--transition-base);
}

.btn-secondary:hover {
  background: var(--color-background);
  border-color: var(--color-border-light);
}

/* 返回按钮 */
.btn-back {
  position: absolute;
  top: var(--spacing-lg);
  left: var(--spacing-lg);
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: transparent;
  border: none;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-family: var(--font-family);
  cursor: pointer;
  transition: all var(--transition-base);
  border-radius: var(--radius-sm);
}

.btn-back:hover {
  color: var(--color-text);
  background: var(--color-background);
}

.btn-back svg {
  transition: transform var(--transition-fast), scale var(--ui-motion-fast) var(--ui-motion-ease);
}

.btn-back:hover svg {
  transform: translateX(-2px);
}
.login-submit, .captcha-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
.login-feedback-region { min-height: 42px; margin-top: 10px; }
.login-feedback { padding: 9px 12px; border-radius: var(--radius-sm); background: var(--color-background); color: var(--color-text-secondary); font-size: var(--font-size-xs); line-height: 1.7; overflow-wrap: anywhere; }
.login-feedback.error { color: var(--color-error); }
.login-feedback.success { color: var(--color-success); }
.login-submit .loading-spinner { border-top-color: currentColor; }
@media (prefers-reduced-motion: reduce) { .form-content { animation: none; } }
</style>
