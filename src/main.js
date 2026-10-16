// 最先导入日志系统
import { logger } from './utils/logger.js'

import { createApp } from 'vue'
import './styles/index.css'
import App from './App.vue'
import { initSettings } from './stores/settingsStore.js'

async function bootstrap() {
	try {
		// 设置读取与本地服务启动并行；App 挂载后的首批 API 请求不会抢在监听之前。
		const [settingsResult, backendResult] = await Promise.allSettled([
			initSettings(),
			window.electronAPI?.waitForBackend?.()
		])
		if (settingsResult.status === 'rejected') logger.error('main', '初始化设置失败', settingsResult.reason)
		if (backendResult.status === 'rejected' || backendResult.value === false) {
			logger.warn('main', '本地服务未就绪，仍打开界面以便重试', backendResult.reason)
		}
	} catch (err) {
		logger.error('main', '初始化设置失败', err)
	} finally {
		const app = createApp(App)
		app.mount('#app')
		requestAnimationFrame(() => window.electronAPI?.notifyReady?.())
	}
}

void bootstrap()
