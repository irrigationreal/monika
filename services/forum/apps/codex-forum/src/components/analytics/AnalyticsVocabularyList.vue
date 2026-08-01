<script setup lang="ts">
import { computed, ref } from 'vue';

import type { AnalyticsVocabularyGroupDto } from '@irrigationreal/codex-forum-contracts';

const props = defineProps<{ group: AnalyticsVocabularyGroupDto }>();
const expanded = ref(false);
const visibleTerms = computed(() => (expanded.value ? props.group.terms : props.group.terms.slice(0, 10)));
</script>

<template>
  <section class="analytics-vocabulary-group">
    <h3>{{ group.forumName }} · {{ group.audience }}</h3>
    <p>{{ group.postCount }} posts in this corpus. Terms are ranked by distinctiveness.</p>
    <ol v-if="group.terms.length" class="analytics-vocabulary-list">
      <li v-for="(term, index) in visibleTerms" :key="term.term">
        <strong
          ><span class="analytics-vocabulary-rank">{{ index + 1 }}.</span> {{ term.term }}</strong
        >
        <span>{{ term.count }} uses · {{ term.documentCount }} posts · score {{ term.score.toFixed(2) }}</span>
      </li>
    </ol>
    <p v-else>Not enough repeated vocabulary.</p>
    <button v-if="group.terms.length > 10" type="button" class="vb-small-btn" @click="expanded = !expanded">
      {{ expanded ? 'Show top 10' : `Show all ${group.terms.length}` }}
    </button>
  </section>
</template>
