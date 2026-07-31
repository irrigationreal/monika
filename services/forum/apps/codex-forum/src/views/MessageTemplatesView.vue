<script setup lang="ts">
import MessageTemplateManager from '../components/MessageTemplateManager.vue';
</script>
<template>
  <section class="vb-section vb-message-templates-view">
    <div class="vb-table-header">Message Templates</div>
    <div class="vb-message-templates-panel" data-testid="message-templates-panel">
      <MessageTemplateManager />
    </div>
  </section>
</template>

<style scoped>
.vb-message-templates-view {
  min-width: 0;
}

.vb-message-templates-panel {
  min-width: 0;
  padding: 18px;
  border: 1px solid var(--border-muted);
  border-top: 0;
  background: var(--bg-surface-alt);
  color: var(--text-primary);
  box-shadow: 0 2px 6px var(--shadow-color);
  animation: vb-fade-in var(--transition-normal);
}

@media (max-width: 600px) {
  .vb-message-templates-panel {
    padding: 10px;
  }
}
</style>
