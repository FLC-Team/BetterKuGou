<template>
  <details ref="element" :open="initialOpen" class="animated-details">
    <summary><slot name="summary" /></summary>
    <div class="animated-details-content"><slot /></div>
  </details>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createDetailsMotion } from './detailsMotion.js'

const props = defineProps({ open: { type: Boolean, default: false } })
const initialOpen = props.open
const element = ref(null)
let motion
onMounted(() => { motion = createDetailsMotion(element.value) })
watch(() => props.open, value => motion?.setOpen(value))
onBeforeUnmount(() => motion?.dispose())
</script>

<style scoped>
summary { cursor: pointer; transition: color var(--transition-fast), background-color var(--transition-fast), scale .16s ease; }
summary:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
.animated-details-content { display: flow-root; min-width: 0; }
</style>
