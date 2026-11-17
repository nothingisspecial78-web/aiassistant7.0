import fs from 'node:fs/promises';
import path from 'node:path';
import {
  AppProfileSchema,
  DEFAULT_APP_ID,
  DEFAULT_ASSISTANT_TITLE,
  EvalSuiteSchema,
  SheetTemplateSchema,
  type AppProfile,
  type EvalSuite,
  type SheetTemplate,
} from '../../core/index.ts';
import { logger } from '../config.ts';

export interface LoadedDoc {
  source: string;
  content: string;
}

export interface LoadedProfileBundle {
  profile: AppProfile;
  docs: LoadedDoc[];
  templates: Map<string, SheetTemplate>;
  evalSuite?: EvalSuite;
}

export const DEFAULT_BUILTIN_PROFILE: AppProfile = AppProfileSchema.parse({
  appId: DEFAULT_APP_ID,
  displayName: DEFAULT_ASSISTANT_TITLE,
  systemPrompt:
    'You are a helpful, accurate AI Assistant integrated into this web application. Use attached files, live application state, right-clicked UI context, and registered tools to assist the user in English or Malayalam.',
  refusalMessage:
    'I can help with tasks, data, and navigation inside this application. Please ask something related to the current workspace or attach a document/screenshot.',
  corsOrigins: ['*'],
  api: { baseUrl: '' },
  auth: { mode: 'hybrid' },
  tools: [
    'search_entities',
    'get_entity_details',
    'query_entities',
    'export_data',
    'search_guides',
    'start_guide',
    'controlAppUi',
  ],
  customTools: [],
  languages: ['en', 'ml'],
});

export class ProfileRegistry {
  private readonly bundles = new Map<string, LoadedProfileBundle>();

  constructor() {
    this.registerProfile(DEFAULT_BUILTIN_PROFILE, [
      {
        source: 'getting-started.md',
        content: [
          '# Universal AI Assistant Guide',
          'The AI Assistant helps users search live workspace records, export reports (Excel, PDF, CSV, Word, JSON, Text), navigate pages using interactive Step-by-Step Guide mode, attach screenshots or spreadsheets, and inspect any UI element via right-click.',
        ].join('\n\n'),
      },
    ]);
  }

  registerProfile(
    profileInput: AppProfile,
    docs: LoadedDoc[] = [],
    templatesList: SheetTemplate[] = []
  ): LoadedProfileBundle {
    const profile = AppProfileSchema.parse(profileInput);
    const templates = new Map<string, SheetTemplate>();
    for (const t of templatesList) {
      const parsed = SheetTemplateSchema.parse(t);
      templates.set(parsed.templateId, parsed);
    }
    const bundle: LoadedProfileBundle = {
      profile,
      docs,
      templates,
    };
    this.bundles.set(profile.appId, bundle);
    return bundle;
  }

  async loadAll(profilesDir: string): Promise<void> {
    if (!profilesDir) return;
    let entries: string[];
    try {
      const dirents = await fs.readdir(profilesDir, { withFileTypes: true });
      entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (err) {
      logger.debug({ profilesDir, err }, 'Optional profilesDir not found; using built-in defaults');
      return;
    }

    for (const folder of entries) {
      const folderPath = path.join(profilesDir, folder);
      const profilePath = path.join(folderPath, 'profile.json');
      try {
        const rawProfile = await fs.readFile(profilePath, 'utf8');
        const profile = AppProfileSchema.parse(JSON.parse(rawProfile));

        const docs: LoadedDoc[] = [];
        const docsDir = path.join(folderPath, 'docs');
        try {
          const docFiles = (await fs.readdir(docsDir)).filter((f) => f.endsWith('.md')).sort();
          for (const docFile of docFiles) {
            const content = await fs.readFile(path.join(docsDir, docFile), 'utf8');
            docs.push({ source: docFile, content });
          }
        } catch {
          // docs optional
        }

        const templates = new Map<string, SheetTemplate>();
        const templatesDir = path.join(folderPath, 'templates');
        try {
          const tplFiles = (await fs.readdir(templatesDir)).filter((f) => f.endsWith('.json')).sort();
          for (const tplFile of tplFiles) {
            const rawTpl = await fs.readFile(path.join(templatesDir, tplFile), 'utf8');
            const parsedTpl = SheetTemplateSchema.parse(JSON.parse(rawTpl));
            templates.set(parsedTpl.templateId, parsedTpl);
          }
        } catch {
          // templates optional
        }

        let evalSuite: EvalSuite | undefined;
        const evalPath = path.join(folderPath, 'eval.json');
        try {
          const rawEval = await fs.readFile(evalPath, 'utf8');
          evalSuite = EvalSuiteSchema.parse(JSON.parse(rawEval));
        } catch {
          // eval optional
        }

        this.bundles.set(profile.appId, {
          profile,
          docs,
          templates,
          evalSuite,
        });
      } catch (err) {
        logger.error({ folder, err }, 'Failed to load app profile');
      }
    }
  }

  getBundle(appId: string): LoadedProfileBundle | undefined {
    return this.bundles.get(appId);
  }

  getProfile(appId: string): AppProfile | undefined {
    return this.bundles.get(appId)?.profile;
  }

  getDefaultProfile(): AppProfile {
    return (
      this.bundles.get(DEFAULT_APP_ID)?.profile ||
      this.bundles.values().next().value?.profile ||
      DEFAULT_BUILTIN_PROFILE
    );
  }

  listProfiles(): AppProfile[] {
    return Array.from(this.bundles.values()).map((b) => b.profile);
  }

  getDocs(appId: string): LoadedDoc[] {
    return this.bundles.get(appId)?.docs || [];
  }

  getTemplate(appId: string, templateId?: string): SheetTemplate | undefined {
    const bundle = this.bundles.get(appId) || this.bundles.get(DEFAULT_APP_ID);
    if (!bundle) return undefined;
    if (templateId) return bundle.templates.get(templateId);
    return bundle.templates.values().next().value;
  }

  getTemplates(appId: string): SheetTemplate[] {
    const bundle = this.bundles.get(appId) || this.bundles.get(DEFAULT_APP_ID);
    return bundle ? Array.from(bundle.templates.values()) : [];
  }

  getEvalSuite(appId: string): EvalSuite | undefined {
    return this.bundles.get(appId)?.evalSuite;
  }
}
