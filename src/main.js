// 最先导入日志系统
import { logger } from './utils/logger.js'

import { createApp } from 'vue'
import './styles/index.css'
import App from './App.vue'
import { initSettings } from './stores/settingsStore.js'

async function bootstrap() {
	try {
		await initSettings()
	} catch (err) {
		logger.error('main', '初始化设置失败', err)
	} finally {
		const app = createApp(App)
		app.mount('#app')
	}
}

void bootstrap()
