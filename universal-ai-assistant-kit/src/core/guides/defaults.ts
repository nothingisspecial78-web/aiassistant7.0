import type { GuideDef } from './types.ts';

/**
 * Host-agnostic built-in default guides.
 * Host apps supply domain-specific guides via `createUniversalAssistantRouter({ guides })`.
 */
export const BUILTIN_DEFAULT_GUIDES: GuideDef[] = [
  {
    guideId: 'default.getting_started',
    title: {
      en: 'Explore the AI Assistant & Workspace',
      ml: 'എഐ അസിസ്റ്റന്റും വർക്ക്‌സ്‌പേസും പരിചയപ്പെടുക',
    },
    summary: {
      en: 'Quick walkthrough showing how to inspect elements, upload files, export data, and trigger guided workflows.',
      ml: 'ഫയലുകൾ അപ്‌ലോഡ് ചെയ്യാനും ഡാറ്റ എക്സ്പോർട്ട് ചെയ്യാനും ഗൈഡ് മോഡ് ഉപയോഗിക്കാനും സഹായിക്കുന്ന മാർഗ്ഗരേഖ.',
    },
    keywords: [
      'getting started',
      'help',
      'tour',
      'overview',
      'how to use',
      'assistant help',
      'സഹായം',
    ],
    roles: 'public',
    steps: [
      {
        stepId: 'open-composer',
        target: {
          guideId: 'uai-composer-input',
          fallbacks: ['[data-uai-id="composer-input"]', 'textarea', 'input[type="text"]'],
        },
        instruction: {
          en: 'Ask any question here, attach Excel/CSV/PDF/images, or request reports.',
          ml: 'ഇവിടെ ഏത് ചോദ്യവും ചോദിക്കാം, അല്ലെങ്കിൽ ഫയലുകൾ അറ്റാച്ച് ചെയ്യാം.',
        },
        action: 'read',
        completeWhen: { type: 'manual' },
      },
    ],
    completion: {
      message: {
        en: 'You are ready to use all assistant features!',
        ml: 'അസിസ്റ്റന്റിന്റെ എല്ലാ സൗകര്യങ്ങളും ഉപയോഗിക്കാൻ നിങ്ങൾ തയ്യാറാണ്!',
      },
      followUpChips: ['Summarize visible data', 'Export data as CSV'],
    },
  },
];

export const AUTHORED_GUIDES: GuideDef[] = BUILTIN_DEFAULT_GUIDES;
