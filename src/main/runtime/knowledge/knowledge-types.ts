export type KnowledgeScope = 'system' | 'agent' | 'project' | 'external';
export type KnowledgeSearchScope = KnowledgeScope;

export type KnowledgeProviderKind = 'openagent-system-compiler' | 'external-mcp' | 'remote-service' | 'custom';
export type KnowledgeSource = KnowledgeProviderKind | string;

export type KnowledgeCapability =
  | 'ingest'
  | 'ingest_file'
  | 'compile'
  | 'compile_topic'
  | 'search'
  | 'query'
  | 'capture'
  | 'provenance'
  | 'graph'
  | 'health'
  | 'lint';

export interface KnowledgeProviderDescriptor {
  id: string;
  kind: KnowledgeProviderKind;
  scope: KnowledgeScope;
  displayName: string;
  rootPath?: string;
  capabilities: KnowledgeCapability[];
}

export interface KnowledgeQueryInput {
  scope: KnowledgeSearchScope;
  providerId?: string;
  agentId?: string;
  query: string;
  limit?: number;
}

export interface KnowledgeSearchInput extends KnowledgeQueryInput {}

export interface KnowledgeIngestInput {
  scope: KnowledgeScope;
  providerId?: string;
  agentId?: string;
  title: string;
  content: string;
  sourceId?: string;
  tags?: string[];
  originalFiles?: KnowledgeOriginalFile[];
  compile?: boolean;
  tier?: KnowledgeCompileTier;
}

export interface KnowledgeIngestFileInput {
  scope: KnowledgeScope;
  providerId?: string;
  filePath: string;
  title?: string;
  sourceId?: string;
  tags?: string[];
  compile?: boolean;
  tier?: KnowledgeCompileTier;
}

export interface KnowledgeCompileInput {
  scope: KnowledgeScope;
  providerId?: string;
  sourceIds?: string[];
  limit?: number;
  tier?: KnowledgeCompileTier;
}

export interface KnowledgeCompileTopicInput {
  scope: KnowledgeScope;
  providerId?: string;
  topic: string;
  limit?: number;
  tier?: KnowledgeCompileTier;
}

export interface KnowledgeCaptureInput {
  scope: KnowledgeScope;
  providerId?: string;
  text: string;
  sourceId?: string;
}

export interface KnowledgeProvenanceInput {
  scope: KnowledgeScope;
  providerId?: string;
  targetId: string;
}

export interface KnowledgeGraphInput {
  scope: KnowledgeScope;
  providerId?: string;
  action?: 'get' | 'build';
}

export interface KnowledgeResult {
  id: string;
  title: string;
  source: KnowledgeSource;
  content: string;
  score?: number;
  path?: string;
  citations?: string[];
  metadata?: Record<string, unknown>;
}

export interface KnowledgeAnswer {
  answer: string;
  citations: KnowledgeCitation[];
  usedSourceIds: string[];
  usedArticleIds: string[];
  confidence: KnowledgeConfidence;
}

export interface KnowledgeIngestResult {
  ok: boolean;
  source: KnowledgeSource;
  id?: string;
  path?: string;
  rawPath?: string;
  summaryPath?: string;
  articlePaths?: string[];
  originalFiles?: KnowledgeOriginalFile[];
  message: string;
  data?: unknown;
}

export interface KnowledgeCompileResult {
  ok: boolean;
  source: KnowledgeSource;
  message: string;
  compiled: number;
  skipped: number;
  failed: number;
  articlePaths?: string[];
  data?: unknown;
}

export interface KnowledgeOriginalFile {
  kind: 'media' | 'file';
  path: string;
  originalPath?: string;
  sizeBytes?: number;
  mimeHint?: string;
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

export type KnowledgeSourceKind =
  | 'markdown'
  | 'text'
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'image'
  | 'audio'
  | 'video'
  | 'code'
  | 'conversation'
  | 'web'
  | 'unknown';

export type KnowledgeCompileTier = 0 | 1 | 2 | 3;
export type KnowledgeConfidence = 'low' | 'medium' | 'high';

export interface KnowledgeSourceRecord {
  id: string;
  kind: KnowledgeSourceKind;
  title: string;
  originalPath?: string;
  archivedPath?: string;
  rawTextPath?: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgeCompileItem {
  sourceId: string;
  tier: KnowledgeCompileTier;
  status: 'pending' | 'indexed' | 'summarized' | 'compiled' | 'failed' | 'skipped';
  summaryId?: string;
  conceptIds?: string[];
  articleIds?: string[];
  error?: string;
  lastCompiledAt?: string;
}

export interface KnowledgeSourceSummary {
  id: string;
  sourceId: string;
  title: string;
  language?: string;
  abstract: string;
  keyPoints: string[];
  claims: string[];
  decisions?: string[];
  openQuestions?: string[];
  terms: string[];
  entities: string[];
  citations: KnowledgeCitation[];
  confidence: KnowledgeConfidence;
  createdAt: string;
}

export type KnowledgeConceptType =
  | 'concept'
  | 'entity'
  | 'decision'
  | 'rule'
  | 'workflow'
  | 'module'
  | 'api'
  | 'tool'
  | 'preference'
  | 'open_question';

export interface KnowledgeConcept {
  id: string;
  name: string;
  aliases: string[];
  type: KnowledgeConceptType;
  description: string;
  sourceIds: string[];
  confidence: KnowledgeConfidence;
  articleId?: string;
}

export type KnowledgeRelationType =
  | 'implements'
  | 'extends'
  | 'depends_on'
  | 'contradicts'
  | 'derived_from'
  | 'related_to'
  | 'trades_off'
  | 'prerequisite_of'
  | 'mentions'
  | 'supports';

export interface KnowledgeRelation {
  id: string;
  sourceConceptId: string;
  targetConceptId: string;
  type: KnowledgeRelationType;
  evidence: string;
  sourceIds: string[];
  confidence: KnowledgeConfidence;
}

export interface KnowledgeArticle {
  id: string;
  conceptId: string;
  title: string;
  path: string;
  aliases: string[];
  sourceIds: string[];
  relationIds: string[];
  frontmatter: Record<string, unknown>;
  updatedAt: string;
}

export interface KnowledgeCitation {
  sourceId: string;
  path?: string;
  quote?: string;
  location?: string;
}

export interface KnowledgeProvenance {
  id: string;
  targetId: string;
  targetType: 'summary' | 'concept' | 'relation' | 'article' | 'answer';
  sourceId: string;
  sourcePath?: string;
  quote?: string;
  location?: string;
  createdAt: string;
  confirmedByUser?: boolean;
  confidence: KnowledgeConfidence;
}

export interface KnowledgeCaptureDraft {
  id: string;
  kind: 'decision' | 'correction' | 'preference' | 'project_rule' | 'open_question' | 'note';
  title: string;
  content: string;
  reason: string;
  confidence: KnowledgeConfidence;
  evidence?: string;
}

export interface KnowledgeManifest {
  version: 1;
  providerId: string;
  updatedAt: string;
  sources: Record<string, KnowledgeSourceRecord>;
  compileItems: Record<string, KnowledgeCompileItem>;
  articles: Record<string, KnowledgeArticle>;
}


export interface KnowledgeSourceListItem {
  id: string;
  title: string;
  kind: KnowledgeSourceKind;
  status?: KnowledgeCompileItem['status'];
  tier?: KnowledgeCompileTier;
  rawTextPath?: string;
  createdAt: string;
  updatedAt: string;
  articleIds?: string[];
  quality?: KnowledgeQualityReport;
}

export interface KnowledgeArticleListItem {
  id: string;
  conceptId: string;
  title: string;
  path: string;
  sourceIds: string[];
  updatedAt: string;
}

export interface KnowledgeQualityReport {
  sourceId: string;
  title: string;
  score: number;
  grade: 'good' | 'needs_review' | 'poor' | string;
  issues: string[];
  metrics: Record<string, number>;
  generatedAt: string;
}

export interface KnowledgeBrowseSnapshot {
  provider: KnowledgeProviderDescriptor;
  root: string;
  sources: KnowledgeSourceListItem[];
  articles: KnowledgeArticleListItem[];
  pending: KnowledgeSourceListItem[];
  quality: KnowledgeQualityReport[];
}

export interface KnowledgeArticleReadResult {
  ok: boolean;
  source: KnowledgeSource;
  articleId: string;
  title?: string;
  path?: string;
  content?: string;
  message?: string;
}

export interface KnowledgeProvider {
  readonly source: KnowledgeSource;
  descriptor(): KnowledgeProviderDescriptor;
  search(input: KnowledgeSearchInput): Promise<KnowledgeResult[]>;
  query?(input: KnowledgeQueryInput): Promise<KnowledgeAnswer>;
  ingest?(input: KnowledgeIngestInput): Promise<KnowledgeIngestResult>;
  ingestFile?(input: KnowledgeIngestFileInput): Promise<KnowledgeIngestResult>;
  compile?(input: KnowledgeCompileInput): Promise<KnowledgeCompileResult>;
  compileTopic?(input: KnowledgeCompileTopicInput): Promise<KnowledgeCompileResult>;
  capture?(input: KnowledgeCaptureInput): Promise<KnowledgeCaptureDraft[]>;
  provenance?(input: KnowledgeProvenanceInput): Promise<KnowledgeProvenance[]>;
  graph?(input: KnowledgeGraphInput): Promise<KnowledgeGraphResult>;
  health?(): Promise<KnowledgeHealthResult>;
  lint?(): Promise<KnowledgeLintResult>;
  browse?(): KnowledgeBrowseSnapshot | Promise<KnowledgeBrowseSnapshot>;
  readArticle?(articleId: string): KnowledgeArticleReadResult | Promise<KnowledgeArticleReadResult>;
}
