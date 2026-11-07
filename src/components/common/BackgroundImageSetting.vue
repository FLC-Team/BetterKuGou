<template>
  <div class="background-image-setting">
    <div>
      <label class="background-image-label" :for="id">{{ label }}</label>
      <p v-if="description" class="background-image-description">{{ description }}</p>
      <p v-if="!available" class="background-image-description">请在桌面应用中选择图片。</p>
      <p v-else-if="previewFailed" class="background-image-description">此设备上的背景图片不可用，请重新选择。</p>
    </div>
    <div class="background-image-actions" :aria-busy="busy">
      <Transition name="ui-fade">
        <img v-if="previewUrl && !previewFailed" :src="previewUrl" class="background-image-preview" alt="" @error="previewFailed = true">
      </Transition>
      <button :id="id" class="btn btn-secondary" type="button" :disabled="disabled || !available || busy" @click="fileInput?.click()">
        {{ busy ? '正在处理…' : modelValue ? '更换图片' : '选择图片' }}
      </button>
      <button v-if="modelValue" class="btn btn-secondary" type="button" :disabled="disabled || busy" @click="emit('update:modelValue', '')">
        清除图片
      </button>
      <input ref="fileInput" type="file" accept="image/*,.avif,.svg" hidden @change="selectImage">
    </div>
    <AppNotice :message="errorMessage" :revision="errorRevision" title="背景图片" type="error" />
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import { MAX_BACKGROUND_IMAGE_BYTES, backgroundImageUrl } from '../../../electron/backgroundImage.mjs'
import { logger } from '../../utils/logger.js'

const props = defineProps({
  modelValue: { type: String, default: '' },
  id: { type: String, default: '' },
  label: { type: String, default: '主界面背景' },
  description: { type: String, default: '' },
  disabled: Boolean
})
const emit = defineEmits(['update:modelValue'])
const generatedId = useId()
const id = computed(() => props.id || generatedId)
const available = typeof window.electronAPI?.storeBackgroundImage === 'function'
const fileInput = ref(null)
const busy = ref(false)
const errorMessage = ref('')
const errorRevision = ref(0)
const previewUrl = computed(() => backgroundImageUrl(props.modelValue))
const previewFailed = ref(false)
const maxSourceBytes = 32 * 1024 * 1024
const maxImageDimension = 3840
let selectionRevision = 0
let disposed = false

watch(previewUrl, () => {
  previewFailed.value = false
  selectionRevision++
}, { flush: 'sync' })
onBeforeUnmount(() => { disposed = true })

/** Decode using Chromium's image support and keep a size-bounded copy without source metadata. */
async function encodeImage(file) {
  if (file.size > maxSourceBytes) throw new Error('请选择不超过 32 MB 的图片。')
  const source = URL.createObjectURL(file)
  const image = new Image()
  try {
    image.src = source
    try { await image.decode() } catch (error) {
      throw new Error('无法读取此图片，请检查文件或换一张图片。', { cause: error })
    }
    const scale = Math.min(1, maxImageDimension / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height)
    const snapshot = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.9))
    if (!snapshot || snapshot.type !== 'image/webp' || snapshot.size > MAX_BACKGROUND_IMAGE_BYTES) {
      throw new Error('无法生成背景图片，请换一张图片。')
    }
    return new Uint8Array(await snapshot.arrayBuffer())
  } finally {
    URL.revokeObjectURL(source)
  }
}

/** Only replace the current draft after the chosen image has been decoded and saved. */
async function selectImage(event) {
  const input = event.target
  const file = input.files?.[0]
  input.value = ''
  if (!file || props.disabled || busy.value) return

  const revision = selectionRevision
  const isCurrent = () => !disposed && !props.disabled && selectionRevision === revision
  busy.value = true
  errorMessage.value = ''
  try {
    const bytes = await encodeImage(file)
    if (!isCurrent()) return
    const storedId = await window.electronAPI.storeBackgroundImage(bytes)
    if (!isCurrent()) return
    if (!backgroundImageUrl(storedId)) throw new Error('背景图片保存结果无效。')
    previewFailed.value = false
    emit('update:modelValue', storedId)
  } catch (error) {
    if (!isCurrent()) return
    logger.warn('BackgroundImageSetting', '更改背景图片失败', { name: error.name, code: error.code })
    errorMessage.value = error.message || '无法更改背景图片，请重试。'
    errorRevision.value++
  } finally {
    if (!disposed) busy.value = false
  }
}
</script>

<style scoped>
.background-image-setting {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-sm) var(--spacing-md);
  min-width: 0;
}

.background-image-label {
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.background-image-description {
  margin: var(--spacing-xs) 0 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}

.background-image-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-sm);
}

.background-image-preview {
  display: block;
  width: 76px;
  height: 48px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  object-fit: cover;
}
</style>
