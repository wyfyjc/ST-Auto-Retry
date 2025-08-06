import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';

// 扩展唯一标识符
const MODULE_NAME = 'auto_retry';

// 默认设置
const defaultSettings = Object.freeze({
    enabled: false,
    retryOnEmpty: true,
    retryOnShort: true,
    minLength: 10,
    retryOnMissingString: false,
    requiredString: '',
    retryOnFastGeneration: false,
    minGenerationTime: 10000,
    maxRetries: 3,
    retryDelay: 1000
});

// --- 状态变量 ---
let retryCount = 0;
let isRetrying = false; // 标志插件是否正在等待重试生成的结果
let userStoppedGeneration = false;
let isChecking = false; // 【关键锁】标志插件是否正处于GENERATION_ENDED后的检查窗口期

// 获取或初始化设置
function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwnProperty.call(extension_settings[MODULE_NAME], key)) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extension_settings[MODULE_NAME];
}

// 保存设置
function saveSettings() {
    saveSettingsDebounced();
}

// 计算生成时间（从stats.js复制）
function calculateGenTime(gen_started, gen_finished) {
    if (gen_started === undefined || gen_finished === undefined) {
        return 0;
    }
    let startDate = new Date(gen_started);
    let endDate = new Date(gen_finished);
    return endDate.getTime() - startDate.getTime();
}

// 从消息数据获取生成时间
function getLastMessageGenTime() {
    try {
        const context = SillyTavern.getContext();
        if (context && context.chat && context.chat.length > 0) {
            const lastMessage = context.chat[context.chat.length - 1];
            if (lastMessage && lastMessage.gen_started && lastMessage.gen_finished) {
                return calculateGenTime(lastMessage.gen_started, lastMessage.gen_finished);
            }
        }
    } catch (error) {
        console.error('[Auto Retry] 获取消息生成时间失败:', error);
    }
    return null;
}



// 检查消息是否需要重试
function shouldRetry() {
    const settings = getSettings();
    if (!settings.enabled || userStoppedGeneration) {
        if (userStoppedGeneration) console.log('[Auto Retry] 用户已中止，跳过重试检查。');
        return false;
    }
    let messageText = '';
    try {
        const context = SillyTavern.getContext();
        if (context && context.chat && Array.isArray(context.chat) && context.chat.length > 0) {
            const lastMessage = context.chat[context.chat.length - 1];
            if (lastMessage && typeof lastMessage === 'object') {
                messageText = lastMessage.mes || lastMessage.message || lastMessage.content || lastMessage.text || '';
            }
        }
    } catch (error) {
        console.error('[Auto Retry] 获取消息时发生错误:', error);
        return false;
    }
    const trimmedText = messageText.trim();
    console.log(`[Auto Retry] 最终消息检查 - 长度: ${trimmedText.length}, 内容预览: "${trimmedText.substring(0, 50)}${trimmedText.length > 50 ? '...' : ''}"`);
    if (settings.retryOnEmpty && trimmedText.length === 0) {
        console.log('[Auto Retry] 条件满足：空回复。');
        return true;
    }
    if (settings.retryOnShort && trimmedText.length < settings.minLength) {
        console.log(`[Auto Retry] 条件满足：回复过短 (长度 ${trimmedText.length} < 阈值 ${settings.minLength})。`);
        return true;
    }
    if (settings.retryOnMissingString && settings.requiredString && !trimmedText.includes(settings.requiredString)) {
        console.log(`[Auto Retry] 条件满足：缺少必需字符串 "${settings.requiredString}"。`);
        return true;
    }
    if (settings.retryOnFastGeneration) {
        const genTime = getLastMessageGenTime();
        if (genTime !== null && genTime < settings.minGenerationTime) {
            console.log(`[Auto Retry] 条件满足：生成时间过短 (${genTime}ms < ${settings.minGenerationTime}ms)。`);
            return true;
        }
    }
    return false;
}

// 执行重试
async function performRetry() {
    const settings = getSettings();
    if (retryCount >= settings.maxRetries) {
        console.log(`[Auto Retry] 已达到最大重试次数 (${settings.maxRetries})，停止重试。`);
        isChecking = false; // 【解锁】达到最大次数，解锁并结束
        return;
    }
    
    retryCount++;
    isRetrying = true; // 进入重试状态
    isChecking = false; // 【解锁】检查阶段结束，解锁
    
    console.log(`[Auto Retry] 执行第 ${retryCount}/${settings.maxRetries} 次重试...`);
    try {
        if (settings.retryDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, settings.retryDelay));
        }
        let swipeSuccess = false;
        const swipeSelectors = ['.swipe_right', '.mes_buttons .swipe_right', '#chat .swipe_right', '.last_mes .swipe_right', '[title="Swipe right"]', '.fa-chevron-right.interactable'];
        for (const selector of swipeSelectors) {
            const swipeButton = document.querySelector(selector);
            if (swipeButton && swipeButton.style.display !== 'none' && !swipeButton.classList.contains('disabled') && !swipeButton.classList.contains('hidden')) {
                console.log(`[Auto Retry] 通过点击按钮 (${selector}) 触发重试。`);
                swipeButton.click();
                swipeSuccess = true;
                break;
            }
        }
        if (!swipeSuccess) {
            console.log('[Auto Retry] 无法找到可用的swipe方法，停止重试。');
            isRetrying = false; // 重试失败，解除重试状态
        }
    } catch (error) {
        console.error('[Auto Retry] 重试时发生错误:', error);
        isRetrying = false; // 重试失败，解除重试状态
    }
}

// --- 事件处理器 ---

/**
 * 处理生成开始事件。
 */
function handleGenerationStarted() {
    // 【关键保护】如果插件正在检查或正在重试，则忽略任何GENERATION_STARTED事件，防止状态被意外重置。
    if (isChecking || isRetrying) {
        console.log(`[Auto Retry] 插件工作中 (isChecking: ${isChecking}, isRetrying: ${isRetrying})，忽略 GENERATION_STARTED 事件。`);
        // 如果是由重试触发的，将isRetrying标志重置，表示我们已收到重试的开始信号
        if(isRetrying) isRetrying = false; 
        return;
    }
    // 只有在插件完全空闲时，才将其视为新的用户周期并重置一切。
    console.log('%c[Auto Retry] 检测到新的用户生成周期，重置所有状态。', 'color: #28a745; font-weight: bold;');
    retryCount = 0;
    isRetrying = false;
    userStoppedGeneration = false;
    isChecking = false;
}

/**
 * 【核心逻辑】处理生成结束事件。
 */
function handleGenerationEnded() {
    if (!getSettings().enabled || isRetrying || isChecking) {
        return;
    }
    
    console.log('[Auto Retry] 监听到 GENERATION_ENDED，进入检查窗口期...');
    isChecking = true; // 【上锁】

    setTimeout(() => {
        if (shouldRetry()) {
            performRetry();
        } else {
            console.log('[Auto Retry] 消息符合要求，本轮监测结束。');
            isChecking = false; // 【解锁】检查通过，解锁
        }
    }, 200);
}

/**
 * 处理用户手动中止生成事件
 */
function handleGenerationStopped() {
    console.log('[Auto Retry] 检测到用户手动中止生成。');
    userStoppedGeneration = true;
    isChecking = false; // 如果在检查期间中止，也需要解锁
    isRetrying = false; // 中止也应该取消重试状态
}

/**
 * 处理对话切换事件
 */
function handleChatChanged() {
    console.log('[Auto Retry] 检测到对话切换，重置所有状态。');
    retryCount = 0;
    isRetrying = false;
    userStoppedGeneration = false;
    isChecking = false;
}

// --- UI 部分 (无改动) ---
function renderSettingsHtml() {
    const settings = getSettings();
    return `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>自动重试</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label">
                    <input type="checkbox" id="auto_retry_enabled" ${settings.enabled ? 'checked' : ''}>
                    <span>启用自动重试</span>
                </label>
                <hr>
                <h4>重试条件</h4>
                <label class="checkbox_label">
                    <input type="checkbox" id="auto_retry_on_empty" ${settings.retryOnEmpty ? 'checked' : ''}>
                    <span>空回复时重试</span>
                </label>
                <hr>
                <label class="checkbox_label">
                    <input type="checkbox" id="auto_retry_on_short" ${settings.retryOnShort ? 'checked' : ''}>
                    <span>回复过短时重试</span>
                </label>
                <label for="auto_retry_min_length">最小字符数</label>
                <input type="number" id="auto_retry_min_length" value="${settings.minLength}" min="0" max="1000000" class="text_pole">
                <hr>
                <label class="checkbox_label">
                    <input type="checkbox" id="auto_retry_on_missing_string" ${settings.retryOnMissingString ? 'checked' : ''}>
                    <span>缺少必需字符串时重试</span>
                </label>
                <label for="auto_retry_required_string">必需字符串</label>
                <input type="text" id="auto_retry_required_string" value="${settings.requiredString}" class="text_pole" placeholder="输入必需包含的字符串">
                <hr>
                <label class="checkbox_label">
                    <input type="checkbox" id="auto_retry_on_fast_generation" ${settings.retryOnFastGeneration ? 'checked' : ''}>
                    <span>生成时间过短时重试</span>
                </label>
                <label for="auto_retry_min_generation_time">最小生成时间（毫秒）</label>
                <input type="number" id="auto_retry_min_generation_time" value="${settings.minGenerationTime}" min="1000" max="60000" step="1000" class="text_pole">
                <hr>
                <h4>重试参数</h4>
                <div class="flex-container">
                    <div class="flex1">
                        <label for="auto_retry_max_retries">最大重试次数</label>
                        <input type="number" id="auto_retry_max_retries" value="${settings.maxRetries}" min="1" max="10" class="text_pole">
                    </div>
                    <div class="flex1">
                        <label for="auto_retry_delay">重试延迟（毫秒）</label>
                        <input type="number" id="auto_retry_delay" value="${settings.retryDelay}" min="0" max="60000" step="500" class="text_pole">
                    </div>
                </div>
            </div>
        </div>
    `;
}

function bindSettingsEvents() {
    const s = () => getSettings();
    const save = () => saveSettingsDebounced(); // 使用debounce来防止过于频繁的保存
    $(document).on('change', '#auto_retry_enabled', function() { s().enabled = $(this).prop('checked'); save(); });
    $(document).on('change', '#auto_retry_on_empty', function() { s().retryOnEmpty = $(this).prop('checked'); save(); });
    $(document).on('change', '#auto_retry_on_short', function() { s().retryOnShort = $(this).prop('checked'); save(); });
    $(document).on('input', '#auto_retry_min_length', function() { s().minLength = parseInt($(this).val()) || defaultSettings.minLength; save(); });
    $(document).on('change', '#auto_retry_on_missing_string', function() { s().retryOnMissingString = $(this).prop('checked'); save(); });
    $(document).on('input', '#auto_retry_required_string', function() { s().requiredString = $(this).val() || ''; save(); });
    $(document).on('change', '#auto_retry_on_fast_generation', function() { s().retryOnFastGeneration = $(this).prop('checked'); save(); });
    $(document).on('input', '#auto_retry_min_generation_time', function() { s().minGenerationTime = parseInt($(this).val()) || defaultSettings.minGenerationTime; save(); });
    $(document).on('input', '#auto_retry_max_retries', function() { s().maxRetries = parseInt($(this).val()) || defaultSettings.maxRetries; save(); });
    $(document).on('input', '#auto_retry_delay', function() { s().retryDelay = parseInt($(this).val()) || defaultSettings.retryDelay; save(); });
}

// 初始化扩展
$(document).ready(function() {
    const extensionsMenu = $('#extensions_settings');
    if (extensionsMenu.length) {
        extensionsMenu.append(`<div id="auto_retry_container">${renderSettingsHtml()}</div>`);
        bindSettingsEvents();
    }
    // 注册正确的事件监听器
    eventSource.on(event_types.GENERATION_STARTED, handleGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, handleGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, handleGenerationStopped);
    eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);
    console.log('[Auto Retry] 扩展已初始化 (v4 - 竞争条件修正版)。');
});

