<script setup lang="ts">
defineProps<{
  /** Sanitized HTML returned by the shared renderContent() pipeline. */
  html: string;
}>();
</script>

<template>
  <div v-enhance-mermaid class="vb-rendered-content" v-html="html"></div>
</template>
