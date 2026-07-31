<script setup lang="ts">
defineProps<{
  modelValue: boolean;
  canEdit: boolean;
  busy?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();
</script>

<template>
  <div class="vb-auto-compact-option">
    <label class="vb-checkbox-label">
      <input
        type="checkbox"
        :checked="modelValue"
        :disabled="!canEdit || busy"
        @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
      />
      <span>Auto-compact this thread</span>
    </label>
    <span class="vb-form-hint">
      Summarizes older context near the model limit and automatically retries one context-overflow failure. Compaction
      can lose detail.
      <template v-if="!canEdit"> Only administrators can change this shared setting.</template>
      <template v-else-if="busy"> Wait for the current response to finish before changing it.</template>
    </span>
  </div>
</template>

<style scoped>
.vb-auto-compact-option {
  display: grid;
  gap: 0.25rem;
}

.vb-auto-compact-option .vb-form-hint {
  margin-left: 1.5rem;
}
</style>
