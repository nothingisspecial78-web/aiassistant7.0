import type { AssistantEntityConfig } from './entityRegistry.ts';

/**
 * Generic plug-and-play default assistant config for any host web app.
 * Host apps can pass their own AssistantEntityConfig via createUniversalAssistantRouter({ entityConfig })
 * or register additional apps dynamically with registerAssistantConfig().
 */
export const defaultAssistantConfig: AssistantEntityConfig = {
  appId: 'default',
  appName: 'Host Web App',
  entities: [
    {
      type: 'record',
      label: 'Record',
      pluralLabel: 'records',
      collection: 'records',
      idField: 'id',
      nameField: 'name',
      nameLabel: 'Name',
      defaultExportColumns: ['id', 'name', 'category', 'status'],
      sensitiveFields: ['password', 'passwordHash', 'token', 'secret', 'apiKey'],
      orgField: 'organizationId',
      ownerIdField: 'ownerId',
      searchableFields: ['id', 'name', 'title', 'category', 'status', 'description'],
      displayFields: [
        { key: 'id', label: 'ID' },
        { key: 'category', label: 'Category' },
        { key: 'status', label: 'Status' },
      ],
      detailFields: [
        { key: 'description', label: 'Description' },
        { key: 'createdAt', label: 'Created', format: 'date' },
      ],
      visibilityRules: {
        PUBLIC: 'org',
        SUPER_ADMIN: 'all',
        ADMIN: 'all',
        SECTOR_MANAGER: 'org',
        STUDENT: 'self',
      },
    },
  ],
  pages: [
    {
      pageId: 'default.home',
      title: 'Workspace',
      routePatterns: ['/', '/*'],
      actions: [
        {
          id: 'uai.page.overview',
          label: 'What can you help me with?',
          labelMl: 'എന്തൊക്കെ സഹായങ്ങൾ ലഭിക്കും?',
          prompt: 'Explain what you can help me with on this page.',
          priority: 100,
        },
        {
          id: 'uai.page.guide',
          label: 'Guide me around this page',
          labelMl: 'ഈ പേജ് പരിചയപ്പെടുത്തുക',
          prompt: 'Guide me through the main actions on this page',
          priority: 95,
        },
      ],
    },
  ],
  generalChips: [
    {
      id: 'uai.gen.summary',
      label: 'Summarize visible data',
      labelMl: 'കാണുന്ന വിവരങ്ങൾ ചുരുക്കുക',
      prompt: 'Summarize the data currently visible on this page.',
    },
    {
      id: 'uai.gen.export-csv',
      label: 'Export data as CSV',
      labelMl: 'CSV ആയി എക്സ്പോർട്ട് ചെയ്യുക',
      prompt: 'Export available records as CSV',
    },
  ],
};

export const APP_ASSISTANT_CONFIGS: Record<string, AssistantEntityConfig> = {
  [defaultAssistantConfig.appId]: defaultAssistantConfig,
};

export function registerAssistantConfig(config: AssistantEntityConfig): void {
  APP_ASSISTANT_CONFIGS[config.appId] = config;
}

export function getAssistantConfig(appId: string): AssistantEntityConfig | undefined {
  return APP_ASSISTANT_CONFIGS[appId] || APP_ASSISTANT_CONFIGS.default;
}
