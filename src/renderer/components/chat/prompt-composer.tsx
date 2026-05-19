import { ArrowUp, ChevronDown, Mic, Package, Paperclip, Shield, Sparkles, Square, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import type {
  LlmProviderCatalog,
  PromptAttachmentDescriptor,
  PromptSubmission,
  PromptSubmissionResult,
  SkillCatalogItem
} from '@shared-types/index';
import type { RunStatus } from '@shared-types/events';
import type { WorkspaceMeta } from '@shared-types/events';

interface PromptComposerProps {
  onSubmitPrompt: (payload: PromptSubmission) => Promise<PromptSubmissionResult>;
  onStopRun: (runId?: string) => Promise<{ ok: boolean; error?: string }>;
  onWorkspaceChange: (workspace: WorkspaceMeta) => void;
  runStatus: RunStatus;
  workspace: WorkspaceMeta;
}

const emptyProviderCatalog: LlmProviderCatalog = {
  activeProviderId: '',
  providers: []
};

export function PromptComposer({ onSubmitPrompt, onStopRun, onWorkspaceChange, runStatus, workspace }: PromptComposerProps) {
  const [value, setValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [catalog, setCatalog] = useState<LlmProviderCatalog>(emptyProviderCatalog);
  const [isUpdatingModel, setIsUpdatingModel] = useState(false);
  const [attachments, setAttachments] = useState<PromptAttachmentDescriptor[]>([]);
  const [isPickingAttachments, setIsPickingAttachments] = useState(false);
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogItem[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string>('');
  const [skillPickerIndex, setSkillPickerIndex] = useState(0);
  const lastSkillCatalogRefreshRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const isRunActive = runStatus === 'running' || runStatus === 'waiting_approval';
  const isBusy = isRunActive || isSubmitting || isStopping;
  const runnableProviders = useMemo(
    () =>
      catalog.providers.filter((provider) => {
        const isRunnable = provider.id === 'openai-codex'
          ? Boolean(provider.auth?.configured)
          : Boolean(provider.enabled || provider.auth?.configured);
        return isRunnable && provider.models.length > 0;
      }),
    [catalog.providers]
  );
  const activeProvider = useMemo(
    () =>
      runnableProviders.find((provider) => provider.id === workspace.providerId) ??
      runnableProviders.find((provider) => provider.id === catalog.activeProviderId) ??
      runnableProviders[0] ??
      null,
    [catalog.activeProviderId, runnableProviders, workspace.providerId]
  );

  const activeModelValue =
    activeProvider?.models.find((model) => model.id === workspace.model || model.name === workspace.model)?.id ??
    activeProvider?.defaultModel ??
    '';
  const skillTrigger = getLeadingSkillTrigger(value);
  const isSkillPickerOpen = skillTrigger.active;
  const skillQuery = skillTrigger.query;
  const usableSkills = useMemo(
    () => skillCatalog.filter((skill) => skill.enabled && skill.state !== 'failed'),
    [skillCatalog]
  );
  const filteredSkills = useMemo(() => {
    const next = usableSkills.filter((skill) => {
      if (!skillQuery) {
        return true;
      }

      return [skill.displayName, skill.name, skill.description, skill.sourceLabel]
        .join(' ')
        .toLowerCase()
        .includes(skillQuery);
    });

    return next.slice(0, 8);
  }, [usableSkills, skillQuery]);
  const selectedSkill = useMemo(
    () => skillCatalog.find((skill) => skill.id === selectedSkillId) ?? null,
    [skillCatalog, selectedSkillId]
  );

  useEffect(() => {
    const desktopApi = window.desktopApi;

    if (!desktopApi?.getLlmProviderCatalog) {
      return;
    }

    void desktopApi
      .getLlmProviderCatalog()
      .then((nextCatalog) => {
        setCatalog(nextCatalog);
      })
      .catch((error) => {
        console.error('getLlmProviderCatalog failed', error);
      });
  }, [workspace.providerId, workspace.model]);

  const loadSkillCatalog = useCallback(async (mode: 'list' | 'refresh' = 'list') => {
    const desktopApi = window.desktopApi;
    if (!desktopApi?.getSkillCatalog) {
      return;
    }

    try {
      const nextCatalog =
        mode === 'refresh' && desktopApi.refreshSkills ? await desktopApi.refreshSkills() : await desktopApi.getSkillCatalog();
      setSkillCatalog(nextCatalog);
    } catch (error) {
      console.error(mode === 'refresh' ? 'refreshSkills failed' : 'getSkillCatalog failed', error);
    }
  }, []);

  useEffect(() => {
    void loadSkillCatalog();
  }, [loadSkillCatalog]);

  useEffect(() => {
    if (!isSkillPickerOpen) {
      return;
    }

    const now = Date.now();
    if (now - lastSkillCatalogRefreshRef.current < 1000) {
      return;
    }

    lastSkillCatalogRefreshRef.current = now;
    void loadSkillCatalog('refresh');
  }, [isSkillPickerOpen, loadSkillCatalog]);

  useEffect(() => {
    setSkillPickerIndex(0);
  }, [skillQuery]);

  async function handleSubmit() {
    if (isSkillPickerOpen) {
      const chosenSkill = filteredSkills[skillPickerIndex] ?? filteredSkills[0] ?? null;
      if (chosenSkill) {
        setSelectedSkillId(chosenSkill.id);
      }
      setValue(skillTrigger.prompt);
      setSkillPickerIndex(0);
      return;
    }

    const prompt = value.trim();

    if ((!prompt && attachments.length === 0) || isBusy) return;

    window.desktopApi?.logDiagnostic?.('info', 'prompt composer submit clicked', {
      workspaceRoot: workspace.rootPath,
      promptLength: prompt.length,
      attachmentCount: attachments.length,
      attachmentNames: attachments.map((attachment) => attachment.name)
    });

    const submittedAttachments = attachments;
    setIsSubmitting(true);
    setValue('');
    setAttachments([]);
    setSelectedSkillId('');

    try {
      const result = await onSubmitPrompt({
        prompt,
        attachments: submittedAttachments,
        skillId: selectedSkillId || undefined,
        skillName: selectedSkill?.name || undefined,
        skillDisplayName: selectedSkill?.displayName || selectedSkill?.name || undefined
      });
      if (!result.ok) {
        setValue(prompt);
        setAttachments(submittedAttachments);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleStopRun() {
    if (!isRunActive || isStopping) return;

    window.desktopApi?.logDiagnostic?.('info', 'prompt composer stop clicked', {
      workspaceRoot: workspace.rootPath,
      runStatus
    });

    setIsStopping(true);
    try {
      await onStopRun();
    } finally {
      setIsStopping(false);
    }
  }

  function handleChooseAttachments() {
    if (isBusy || isPickingAttachments) {
      return;
    }

    window.desktopApi?.logDiagnostic?.('info', 'prompt composer choose-attachments clicked', {
      workspaceRoot: workspace.rootPath,
      attachmentCount: attachments.length,
      isBusy,
      isPickingAttachments
    });

    fileInputRef.current?.click();
  }

  function handleRemoveAttachment(path: string) {
    setAttachments((current) => current.filter((attachment) => attachment.path !== path));
  }

  function handleClearSkill() {
    setSelectedSkillId('');
    textareaRef.current?.focus();
  }

  function handlePromptChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const nextValue = event.target.value;
    const wasSkillPickerOpen = isSkillPickerOpen;
    const nextSkillTrigger = getLeadingSkillTrigger(nextValue);

    setValue(nextValue);

    if (!wasSkillPickerOpen && nextSkillTrigger.active) {
      setSkillPickerIndex(0);
    }
  }

  function selectSkill(skill: SkillCatalogItem) {
    setSelectedSkillId(skill.id);
    setValue(skillTrigger.prompt);
    setSkillPickerIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function handleAttachmentFilesSelected(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';

    if (files.length === 0) {
      return;
    }

    setIsPickingAttachments(true);

    try {
      window.desktopApi?.logDiagnostic?.('info', 'prompt composer files selected', {
        workspaceRoot: workspace.rootPath,
        fileCount: files.length,
        fileNames: files.map((file) => file.name)
      });

      const nextAttachments = await Promise.all(
        files.map(async (file) => {
          const kind = file.type.startsWith('image/')
            ? 'image'
            : /\.(txt|md|markdown|json|yml|yaml|ts|tsx|js|jsx|mjs|cjs|css|html|xml|java|kt|py|sh|sql|csv|log)$/i.test(file.name)
              ? 'text'
              : 'binary';

          const dataUrl = await readFileAsDataURL(file);
          const modelImage = kind === 'image' ? await normalizeImageDataUrlForModel(dataUrl, file.type) : null;
          const descriptor: PromptAttachmentDescriptor = {
            id: `attachment-${crypto.randomUUID()}`,
            path: file.name,
            name: file.name,
            size: file.size,
            mimeType: modelImage?.mimeType || file.type || (kind === 'image' ? 'image/*' : kind === 'text' ? 'text/plain' : 'application/octet-stream'),
            kind,
            dataUrl: modelImage?.dataUrl || dataUrl,
            originalDataUrl: dataUrl,
            originalMimeType: file.type || undefined
          };

          if (kind === 'image') {
            return { ...descriptor, imageDataUrl: modelImage?.dataUrl || dataUrl };
          }

          if (kind === 'text') {
            const textContent = await readFileAsText(file);
            return { ...descriptor, textContent };
          }

          return descriptor;
        })
      );

      setAttachments((current) => {
        const next = new Map(current.map((attachment) => [attachment.path, attachment]));
        for (const attachment of nextAttachments) {
          next.set(attachment.path, attachment);
        }
        window.desktopApi?.logDiagnostic?.('info', 'prompt composer attachments merged', {
          workspaceRoot: workspace.rootPath,
          mergedCount: next.size,
          attachments: Array.from(next.values()).map((attachment) => ({
            id: attachment.id,
            name: attachment.name,
            path: attachment.path,
            kind: attachment.kind,
            mimeType: attachment.mimeType,
            hasDataUrl: Boolean(attachment.dataUrl),
            hasTextContent: Boolean(attachment.textContent),
            hasImageDataUrl: Boolean(attachment.imageDataUrl)
          }))
        });
        return Array.from(next.values());
      });
    } finally {
      setIsPickingAttachments(false);
    }
  }

  async function handleModelChange(nextModel: string) {
    const desktopApi = window.desktopApi;

    if (
      !desktopApi?.setActiveLlmProvider ||
      !activeProvider ||
      !nextModel ||
      (nextModel === workspace.model && activeProvider.id === workspace.providerId)
    ) {
      return;
    }

    setIsUpdatingModel(true);

    try {
      const result = await desktopApi.setActiveLlmProvider({
        providerId: activeProvider.id,
        modelId: nextModel
      });

      if (!result.ok) {
        throw new Error(result.error || '切换模型失败');
      }

      setCatalog(result.catalog);
      onWorkspaceChange(result.workspace);
    } catch (error) {
      console.error('setActiveLlmProvider model failed', error);
    } finally {
      setIsUpdatingModel(false);
    }
  }

  async function handleProviderChange(nextProviderId: string) {
    const desktopApi = window.desktopApi;

    const nextProvider = runnableProviders.find((provider) => provider.id === nextProviderId);

    if (!desktopApi?.setActiveLlmProvider || !nextProvider || nextProviderId === activeProvider?.id) {
      return;
    }

    setIsUpdatingModel(true);

    try {
      const result = await desktopApi.setActiveLlmProvider({ providerId: nextProviderId });

      if (!result.ok) {
        throw new Error(result.error || '切换模型提供方失败');
      }

      setCatalog(result.catalog);
      onWorkspaceChange(result.workspace);
    } catch (error) {
      console.error('setActiveLlmProvider failed', error);
    } finally {
      setIsUpdatingModel(false);
    }
  }

  return (
    <div className="composer">
      <div className={`composer-shell ${selectedSkill ? 'has-selected-skill' : ''}`}>
        {selectedSkill && (
          <div className="composer-skill-inline" title={`${selectedSkill.displayName}\n${selectedSkill.description}`}>
            <Package size={12} />
            <span className="composer-skill-inline-name">{selectedSkill.displayName}</span>
            <button
              className="composer-skill-inline-remove"
              type="button"
              onClick={handleClearSkill}
              aria-label={`移除技能 ${selectedSkill.displayName}`}
              title={`移除 ${selectedSkill.displayName}`}
            >
              <X size={11} />
            </button>
          </div>
        )}
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          value={value}
          onChange={handlePromptChange}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          placeholder="输入一个任务，让 agent 开始运行"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || isComposing || event.keyCode === 229) {
              return;
            }

            if (isSkillPickerOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSkillPickerIndex((current) => Math.min(current + 1, Math.max(filteredSkills.length - 1, 0)));
                return;
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSkillPickerIndex((current) => Math.max(current - 1, 0));
                return;
              }

              if (event.key === 'Escape') {
                event.preventDefault();
                setValue('');
                setSkillPickerIndex(0);
                return;
              }

              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void handleSubmit();
                return;
              }
            }

            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
        {isSkillPickerOpen && (
          <div className="composer-skill-picker" role="listbox" aria-label="选择技能">
            <div className="composer-skill-picker-list">
              {filteredSkills.length > 0 ? (
                filteredSkills.map((skill, index) => (
                  <button
                    key={skill.id}
                    type="button"
                    className={`composer-skill-item ${index === skillPickerIndex ? 'active' : ''}`}
                    onMouseEnter={() => setSkillPickerIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectSkill(skill)}
                  >
                    <div className="composer-skill-icon">
                      <Package size={18} />
                    </div>
                    <div className="composer-skill-copy">
                      <div className="composer-skill-name">{skill.displayName}</div>
                      <div className="composer-skill-description">{skill.description || ' '}</div>
                    </div>
                    <div className="composer-skill-source">{skill.sourceLabel}</div>
                  </button>
                ))
              ) : (
                <div className="composer-skill-empty">没有匹配到可用 Skill</div>
              )}
            </div>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="composer-attachment-chip" title={`${attachment.name}\n${attachment.path}`}>
                <Paperclip size={12} />
                <span>{attachment.name}</span>
                <button
                  className="composer-attachment-remove"
                  type="button"
                  onClick={() => handleRemoveAttachment(attachment.path)}
                  aria-label={`删除附件 ${attachment.name}`}
                  title={`删除 ${attachment.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          className="composer-file-input"
          type="file"
          multiple
          onChange={(event) => void handleAttachmentFilesSelected(event)}
          tabIndex={-1}
          aria-hidden="true"
        />
        <div className="composer-footer">
          <div className="composer-actions">
            <button className="toolbar-button" type="button" onClick={handleChooseAttachments} disabled={isBusy || isPickingAttachments}>
              <Paperclip size={14} />
            </button>
            <button className="toolbar-button" type="button">
              <Shield size={14} />
              默认权限
            </button>
            <label className="toolbar-button composer-model-button">
              <Sparkles size={14} />
              <select
                className="composer-model-select"
                value={activeProvider?.id || workspace.providerId || ''}
                onChange={(event) => void handleProviderChange(event.target.value)}
                disabled={runnableProviders.length === 0 || isUpdatingModel}
              >
                {runnableProviders.length ? (
                  runnableProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.name}
                    </option>
                  ))
                ) : (
                  <option value="">等待有效模型配置</option>
                )}
              </select>
              <ChevronDown size={14} />
            </label>
            <label className="toolbar-button composer-model-button">
              <Sparkles size={14} />
              <select
                className="composer-model-select"
                value={activeModelValue}
                onChange={(event) => void handleModelChange(event.target.value)}
                disabled={!activeProvider || activeProvider.models.length === 0 || isUpdatingModel}
              >
                {activeProvider?.models.length ? (
                  activeProvider.models.map((model, index) => (
                    <option key={`${model.id}-${index}`} value={model.id}>
                      {model.name}
                    </option>
                  ))
                ) : (
                  <option value="">{workspace.model || '等待模型配置'}</option>
                )}
              </select>
              <ChevronDown size={14} />
            </label>
            <button className="toolbar-button" type="button">
              <Mic size={14} />
            </button>
          </div>
          <div className="composer-actions">
            {isRunActive ? (
              <button className="danger-button composer-stop-button" type="button" disabled={isStopping} onClick={() => void handleStopRun()}>
                <Square size={14} />
                {isStopping ? '停止中' : '停止'}
              </button>
            ) : (
              <button className="primary-button" type="button" disabled={isBusy} onClick={() => void handleSubmit()}>
                <ArrowUp size={14} />
                发送
              </button>
            )}
          </div>
        </div>
        {runStatus === 'waiting_approval' && (
          <div className="composer-hint mt-8">当前有待审批任务，请先到右侧「摘要」处理后再发送新消息。</div>
        )}
      </div>
    </div>
  );
}

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('读取文本附件失败'));
    reader.readAsText(file);
  });
}

function readFileAsDataURL(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('读取图片附件失败'));
    reader.readAsDataURL(file);
  });
}

const modelSupportedImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function getLeadingSkillTrigger(input: string) {
  if (!input.startsWith('$')) {
    return { active: false, query: '', prompt: input };
  }

  const prompt = input.slice(1).replace(/^\s+/, '');
  const firstNonSpace = prompt.at(0) ?? '';
  const isLikelySkillSearch = /^[a-zA-Z0-9_-]$/.test(firstNonSpace);

  return {
    active: true,
    query: isLikelySkillSearch ? prompt.trim().toLowerCase() : '',
    prompt
  };
}

async function normalizeImageDataUrlForModel(dataUrl: string, mimeType: string) {
  if (modelSupportedImageMimeTypes.has(mimeType)) {
    return { dataUrl, mimeType };
  }

  const converted = await convertImageDataUrlToPng(dataUrl);
  return converted ? { dataUrl: converted, mimeType: 'image/png' } : { dataUrl, mimeType: mimeType || 'image/*' };
}

function convertImageDataUrlToPng(dataUrl: string) {
  return new Promise<string | null>((resolve) => {
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext('2d');
        if (!context || canvas.width === 0 || canvas.height === 0) {
          resolve(null);
          return;
        }
        context.drawImage(image, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      } catch (error) {
        console.warn('convert image attachment to png failed', error);
        resolve(null);
      }
    };
    image.onerror = () => resolve(null);
    image.src = dataUrl;
  });
}
