export type KnowledgeScope = 'system';
export type KnowledgeSearchScope = KnowledgeScope;
export type KnowledgeSource = 'system-wiki';

export interface KnowledgeQueryInput {
  scope: KnowledgeSearchScope;
  agentId?: string;
  query: string;
  limit?: number;
}

export interface KnowledgeIngestInput {
  scope: KnowledgeScope;
  agentId?: string;
  title: string;
  content: string;
  sourceId?: string;
  tags?: string[];
}

export interface KnowledgeResult {
  id: string;
  title: string;
  source: KnowledgeSource;
  content: string;
  score?: number;
  path?: string;
  citations?: string[];
}

export interface KnowledgeIngestResult {
  ok: boolean;
  source: KnowledgeSource;
  id?: string;
  path?: string;
  message: string;
}

export interface KnowledgeHealthResult {
  ok: boolean;
  source: KnowledgeSource;
  message: string;
  data?: unknown;
}

export interface KnowledgeLintResult {
  ok: boolean;
  source: KnowledgeSource;
  message: string;
  reportPath?: string;
  data?: unknown;
}

export interface KnowledgeGraphResult {
  ok: boolean;
  source: KnowledgeSource;
  message: string;
  graphJsonPath?: string;
  graphHtmlPath?: string;
  data?: unknown;
}

export interface KnowledgeProvider {
  readonly source: KnowledgeSource;
  search(input: KnowledgeQueryInput): Promise<KnowledgeResult[]>;
  ingest?(input: KnowledgeIngestInput): Promise<KnowledgeIngestResult>;
  health?(): Promise<KnowledgeHealthResult>;
  lint?(): Promise<KnowledgeLintResult>;
  buildGraph?(): Promise<KnowledgeGraphResult>;
}
