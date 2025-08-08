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

// --- Swipe相关状态变量 ---
let isInitialSwipe = false; // 标志初始生成是否由swipe触发
let lastSwipeId = -1; // 记录上次的swipe_id

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

// 获取当前swipe_id（使用macros.js中的函数）
function getCurrentSwipeId() {
    try {
        // 使用SillyTavern内置的getCurrentSwipeId函数
        if (typeof window.getCurrentSwipeId === 'function') {
            return window.getCurrentSwipeId();
        }
        
        // 备用方法：直接从消息获取
        const context = SillyTavern.getContext();
        if (context && context.chat && context.chat.length > 0) {
            const lastMessage = context.chat[context.chat.length - 1];
            if (lastMessage && typeof lastMessage.swipe_id === 'number') {
                return lastMessage.swipe_id + 1; // 转换为1-based
            }
        }
    } catch (error) {
        console.error('[Auto Retry] 获取swipe_id失败:', error);
    }
    return null;
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



// 检查最后一条消息是否为玩家消息
function isLastMessageFromUser() {
    try {
        const context = SillyTavern.getContext();
        if (context && context.chat && Array.isArray(context.chat) && context.chat.length > 0) {
            const lastMessage = context.chat[context.chat.length - 1];
            if (lastMessage && typeof lastMessage === 'object') {
                // 输出消息结构用于调试
                console.log('%c[Auto Retry] 消息结构:', 'color: #007bff; font-weight: bold;', lastMessage);
                console.log('%c[Auto Retry] 消息属性列表:', 'color: #007bff; font-weight: bold;', Object.keys(lastMessage));
                
                // 只使用is_user属性判断
                const isUser = lastMessage.is_user === true || lastMessage.is_user === 1;
                console.log(`%c[Auto Retry] 最后一条消息is_user: ${lastMessage.is_user}, 判断结果: ${isUser ? '用户消息' : 'AI消息'}`, 'color: #007bff; font-weight: bold;');
                return isUser;  // 返回实际的判断结果，而不是固定的true
            }
        }
    } catch (error) {
        console.error('%c[Auto Retry] 检查消息来源时发生错误:', 'color: #007bff; font-weight: bold;', error);
    }
    return false;
}

// 检查消息是否需要重试
function shouldRetry() {
    const settings = getSettings();
    if (!settings.enabled || userStoppedGeneration) {
        if (userStoppedGeneration) console.log('%c[Auto Retry] 用户已中止，跳过重试检查。', 'color: #007bff; font-weight: bold;');
        return false;
    }
    
    // 检查最后一条消息是否为玩家消息
    const lastMessageFromUser = isLastMessageFromUser();
    if (lastMessageFromUser) {
            console.log('%c[Auto Retry] 检测到最后一条消息为玩家消息，AI生成失败，需要重试。', 'color: #007bff; font-weight: bold;');
            // 检查是否有任何重试条件启用
            if (settings.retryOnEmpty || settings.retryOnShort || settings.retryOnMissingString || settings.retryOnFastGeneration) {
                
                console.log(`自动重试 ${retryCount + 1}/${settings.maxRetries} - 检测到空回复，正在使用重新生成进行重试...`, 'color:rgb(255, 0, 0); font-weight: bold;');
                
                return { needRetry: true, useRegenerate: true, useSwipeRetry: false };
            } else {
                console.log('%c[Auto Retry] 所有重试条件均已禁用，跳过重新生成', 'color: #007bff; font-weight: bold;');
                return { needRetry: false, useRegenerate: false, useSwipeRetry: false };
            }
        }
    
    // 检查swipe失败情况
    if (isInitialSwipe && lastSwipeId >= 0) {
        const currentSwipeId = getCurrentSwipeId();
        if (currentSwipeId !== null) {
            console.log(`%c[Auto Retry] Swipe检查 - 上次: ${lastSwipeId}, 当前: ${currentSwipeId}`, 'color: #007bff; font-weight: bold;');
            
            // 获取消息内容
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
                console.error('%c[Auto Retry] 获取消息内容时发生错误:', 'color: #007bff; font-weight: bold;', error);
            }
            
            const trimmedText = messageText.trim();
            
            if (currentSwipeId === lastSwipeId && trimmedText.length === 0) {
                console.log('%c[Auto Retry] 检测到swipe失败（swipe_id未增加且内容为空），需要重试。', 'color: #007bff; font-weight: bold;');
                // 检查是否有任何重试条件启用
                if (settings.retryOnEmpty || settings.retryOnShort || settings.retryOnMissingString || settings.retryOnFastGeneration) {
                    
                    console.log(`Swipe重试 ${retryCount + 1}/${settings.maxRetries} - 检测到Swipe失败且内容为空，正在重新触发Swipe...`, 'color:rgb(255, 0, 0); font-weight: bold;');
                    
                    return { needRetry: true, useRegenerate: false, useSwipeRetry: true };
                } else {
                    console.log('%c[Auto Retry] 所有重试条件均已禁用，跳过swipe重试', 'color: #007bff; font-weight: bold;');
                    return { needRetry: false, useRegenerate: false, useSwipeRetry: false };
                }
            } else if (currentSwipeId > lastSwipeId) {
                // swipe_id增加了，说明swipe成功，更新lastSwipeId
                console.log(`%c[Auto Retry] Swipe成功，swipe_id从${lastSwipeId}增加到${currentSwipeId}`, 'color: #007bff; font-weight: bold;');
                lastSwipeId = currentSwipeId;
                // 重置swipe状态，因为这次swipe是成功的
                isInitialSwipe = false;
            }
        } else {
            console.error('%c[Auto Retry] 无法获取当前swipe_id进行比较', 'color: #007bff; font-weight: bold;');
        }
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
        console.error('%c[Auto Retry] 获取消息时发生错误:', 'color: #007bff; font-weight: bold;', error);
        return false;
    }
    const trimmedText = messageText.trim();
    console.log(`%c[Auto Retry] 最终消息检查 - 长度: ${trimmedText.length}, 内容预览: "${trimmedText.substring(0, 50)}${trimmedText.length > 50 ? '...' : ''}"`,'color: #007bff; font-weight: bold;');
    if (settings.retryOnEmpty && trimmedText.length === 0) {
        console.log('%c[Auto Retry] 检测到最后一条消息为AI消息，空回复，需要重试。', 'color: #007bff; font-weight: bold;');
        
        console.log(`自动重试 ${retryCount + 1}/${getSettings().maxRetries} - 检测到空回复，正在使用Swipe进行重试...`, 'color:rgb(255, 0, 0); font-weight: bold;');
        
        return { needRetry: true, useRegenerate: false, useSwipeRetry: false };
    }
    if (settings.retryOnShort && trimmedText.length < settings.minLength) {
        console.log(`%c[Auto Retry] 条件满足：回复过短 (长度 ${trimmedText.length} < 阈值 ${settings.minLength})。`, 'color: #007bff; font-weight: bold;');
        return { needRetry: true, useRegenerate: false, useSwipeRetry: false };
    }
    if (settings.retryOnMissingString && settings.requiredString && !trimmedText.includes(settings.requiredString)) {
        console.log(`%c[Auto Retry] 条件满足：缺少必需字符串 "${settings.requiredString}"。`, 'color: #007bff; font-weight: bold;');
        return { needRetry: true, useRegenerate: false, useSwipeRetry: false };
    }
    if (settings.retryOnFastGeneration) {
        const genTime = getLastMessageGenTime();
        if (genTime !== null && genTime < settings.minGenerationTime) {
            console.log(`%c[Auto Retry] 条件满足：生成时间过短 (${genTime}ms < ${settings.minGenerationTime}ms)。`, 'color: #007bff; font-weight: bold;');
            return { needRetry: true, useRegenerate: false, useSwipeRetry: false };
        }
    }
    return { needRetry: false, useRegenerate: false, useSwipeRetry: false };
}

// 执行swipe重试
async function performSwipeRetry() {
    console.log('%c[Auto Retry] 尝试使用swipe重试进行重试...', 'color: #007bff; font-weight: bold;');
    try {
        // 先点击swipe left
        const swipeLeftSelectors = [
            '#swipe_left',
            '.swipe_left',
            '[title="Previous reply"]',
            '.fa-chevron-left'
        ];
        
        let swipeLeftSuccess = false;
        for (const selector of swipeLeftSelectors) {
            const swipeLeftButton = document.querySelector(selector);
            if (swipeLeftButton && swipeLeftButton.style.display !== 'none' && !swipeLeftButton.classList.contains('disabled') && !swipeLeftButton.classList.contains('hidden')) {
                console.log(`%c[Auto Retry] 点击swipe left按钮 (${selector})。`, 'color: #007bff; font-weight: bold;');
                swipeLeftButton.click();
                swipeLeftSuccess = true;
                break;
            }
        }
        
        if (!swipeLeftSuccess) {
            console.log('%c[Auto Retry] 无法找到swipe left按钮，尝试jQuery触发...', 'color: #007bff; font-weight: bold;');
            const swipeLeft = document.querySelector('#swipe_left');
            if (swipeLeft) {
                $(swipeLeft).trigger('click');
                swipeLeftSuccess = true;
            }
        }
        
        if (!swipeLeftSuccess) {
            console.error('%c[Auto Retry] 无法执行swipe left操作。', 'color: #007bff; font-weight: bold;');
            return false;
        }
        
        // 等待一小段时间后点击swipe right
        await new Promise(resolve => setTimeout(resolve, 100));
        
        const swipeRightSelectors = [
            '#swipe_right',
            '.swipe_right',
            '[title="Next reply"]',
            '.fa-chevron-right'
        ];
        
        let swipeRightSuccess = false;
        for (const selector of swipeRightSelectors) {
            const swipeRightButton = document.querySelector(selector);
            if (swipeRightButton && swipeRightButton.style.display !== 'none' && !swipeRightButton.classList.contains('disabled') && !swipeRightButton.classList.contains('hidden')) {
                console.log(`%c[Auto Retry] 点击swipe right按钮 (${selector})。`, 'color: #007bff; font-weight: bold;');
                swipeRightButton.click();
                swipeRightSuccess = true;
                break;
            }
        }
        
        if (!swipeRightSuccess) {
            console.log('%c[Auto Retry] 无法找到swipe right按钮，尝试jQuery触发...', 'color: #007bff; font-weight: bold;');
            const swipeRight = document.querySelector('#swipe_right');
            if (swipeRight) {
                $(swipeRight).trigger('click');
                swipeRightSuccess = true;
            }
        }
        
        if (swipeRightSuccess) {
            // 延迟更新lastSwipeId，等待swipe操作完成
            setTimeout(() => {
                const newSwipeId = getCurrentSwipeId();
                if (newSwipeId !== null) {
                    console.log(`%c[Auto Retry] Swipe重试后更新lastSwipeId从${lastSwipeId}到${newSwipeId}`, 'color: #007bff; font-weight: bold;');
                    lastSwipeId = newSwipeId;
                } else {
                    console.error('%c[Auto Retry] 无法获取swipe重试后的swipe_id', 'color: #007bff; font-weight: bold;');
                }
            }, 300);
        }
        
        return swipeRightSuccess;
    } catch (error) {
        console.error('%c[Auto Retry] swipe重试时发生错误:', 'color: #007bff; font-weight: bold;', error);
        return false;
    }
}

// 执行重新生成
async function performRegenerate() {
    console.log('%c[Auto Retry] 尝试使用重新生成进行重试...', 'color: #007bff; font-weight: bold;');
    try {
        // 查找重新生成按钮 - 使用正确的选择器
        const regenerateSelectors = [
            '#option_regenerate',  // 主要的重新生成按钮
            '.regenerate_button',
            '[title="Regenerate"]',
            '.fa-redo',
            '.fa-refresh'
        ];
        
        let regenerateSuccess = false;
        for (const selector of regenerateSelectors) {
            const regenerateButton = document.querySelector(selector);
            if (regenerateButton && regenerateButton.style.display !== 'none' && !regenerateButton.classList.contains('disabled') && !regenerateButton.classList.contains('hidden')) {
                console.log(`%c[Auto Retry] 通过点击重新生成按钮 (${selector}) 触发重试。`, 'color:rgb(255, 0, 0); font-weight: bold;');
                toastr.info('触发重试');
                regenerateButton.click();
                regenerateSuccess = true;
                break;
            }
        }
        
        if (!regenerateSuccess) {
            console.log('%c[Auto Retry] 无法找到可用的重新生成按钮，尝试触发事件...', 'color: #007bff; font-weight: bold;');
            // 尝试直接触发重新生成按钮的点击事件
            const regenerateOption = document.querySelector('#option_regenerate');
            if (regenerateOption) {
                console.log('%c[Auto Retry] 通过jQuery触发#option_regenerate点击事件。', 'color: #007bff; font-weight: bold;');
                $(regenerateOption).trigger('click');
                regenerateSuccess = true;
            }
        }
        
        return regenerateSuccess;
    } catch (error) {
        console.error('%c[Auto Retry] 重新生成时发生错误:', 'color: #007bff; font-weight: bold;', error);
        return false;
    }
}

// 执行重试
async function performRetry(useRegenerate = false, useSwipeRetry = false) {
    const settings = getSettings();
    if (retryCount >= settings.maxRetries) {
        console.log(`%c[Auto Retry] 已达到最大重试次数 (${settings.maxRetries})，停止重试。`, 'color: #007bff; font-weight: bold;');
        isChecking = false; // 【解锁】达到最大次数，解锁并结束
        return;
    }
    
    retryCount++;
    isRetrying = true; // 进入重试状态
    isChecking = false; // 【解锁】检查阶段结束，解锁
    
    console.log(`%c[Auto Retry] 执行第 ${retryCount}/${settings.maxRetries} 次重试...`, 'color: #007bff; font-weight: bold;');
    try {
        if (settings.retryDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, settings.retryDelay));
        }
        
        let retrySuccess = false;
        
        if (useRegenerate) {
             // 使用重新生成进行重试
             retrySuccess = await performRegenerate();
             if (!retrySuccess) {
                 console.log('%c[Auto Retry] 重新生成失败，尝试使用swipe方法...', 'color: #007bff; font-weight: bold;');
             }
         } else if (useSwipeRetry) {
             console.log('%c[Auto Retry] 使用swipe重试方法...', 'color: #007bff; font-weight: bold;');
             retrySuccess = await performSwipeRetry();
             
             if (!retrySuccess) {
                 console.log('%c[Auto Retry] swipe重试失败，回退到普通swipe...', 'color: #007bff; font-weight: bold;');
             }
         }
         
         // 如果不使用重新生成或重新生成失败，则使用swipe方法
         if (!retrySuccess) {
             const swipeSelectors = ['.swipe_right', '.mes_buttons .swipe_right', '#chat .swipe_right', '.last_mes .swipe_right', '[title="Swipe right"]', '.fa-chevron-right.interactable'];
             for (const selector of swipeSelectors) {
                 const swipeButton = document.querySelector(selector);
                 if (swipeButton && swipeButton.style.display !== 'none' && !swipeButton.classList.contains('disabled') && !swipeButton.classList.contains('hidden')) {
                     console.log(`%c[Auto Retry] 通过点击swipe按钮 (${selector}) 触发重试。`, 'color:rgb(255, 0, 0); font-weight: bold;');
                     toastr.info('触发重试');
                     swipeButton.click();
                     retrySuccess = true;
                     break;
                 }
             }
         }
         
         if (!retrySuccess) {
             console.log('%c[Auto Retry] 无法找到可用的重试方法，停止重试。', 'color: #007bff; font-weight: bold;');
             isRetrying = false; // 重试失败，解除重试状态
         }
     } catch (error) {
         console.error('%c[Auto Retry] 重试时发生错误:', 'color: #007bff; font-weight: bold;', error);
         isRetrying = false; // 重试失败，解除重试状态
     }
}

// --- 事件处理器 ---

/**
 * 处理生成开始事件。
 * 【已修复】: 移除了会过早重置 isRetrying 状态的错误逻辑。
 */
function handleGenerationStarted(data) {
    // 【关键保护】如果插件正在检查或正在重试，则忽略任何GENERATION_STARTED事件，防止状态被意外重置。
    // 这个保护现在是纯粹的，不会修改任何状态。
    if (isChecking || isRetrying) {
        console.log(`%c[Auto Retry] 插件工作中 (isChecking: ${isChecking}, isRetrying: ${isRetrying})，忽略 GENERATION_STARTED 事件。`, 'color: #007bff; font-weight: bold;');
        return;
    }

    // 只有在插件完全空闲时，才将其视为新的用户周期并重置一切。
    console.log('%c[Auto Retry] 检测到新的用户生成周期，重置所有状态。', 'color: #007bff; font-weight: bold;');
    retryCount = 0;
    isRetrying = false;
    userStoppedGeneration = false;
    isChecking = false;

    // 检测是否由swipe触发
    isInitialSwipe = (data === 'swipe');
    if (isInitialSwipe) {
        console.log('%c[Auto Retry] 检测到初始生成由swipe触发。', 'color: #007bff; font-weight: bold;');
        // 获取当前swipe_id并减1作为基准
        const currentSwipeId = getCurrentSwipeId();
        if (currentSwipeId !== null) {
            lastSwipeId = currentSwipeId - 1;
            console.log(`%c[Auto Retry] 记录初始swipe_id: ${lastSwipeId} (当前swipe_id ${currentSwipeId} - 1)`, 'color: #007bff; font-weight: bold;');
        } else {
            console.error('%c[Auto Retry] 无法获取初始swipe_id', 'color: #007bff; font-weight: bold;');
            lastSwipeId = -1;
        }
    } else {
        lastSwipeId = -1;
    }
}


/**
 * 【核心逻辑】处理生成结束事件。
 * 【已修复】: 修正了状态转换逻辑，现在它可以正确处理重试后的响应。
 */
function handleGenerationEnded() {
    // 如果插件未启用，或正在进行另一轮检查，则退出。
    // 注意：我们移除了 isRetrying 的检查，因为我们需要处理重试后的结果。
    if (!getSettings().enabled || isChecking) {
        return;
    }

    console.log('%c[Auto Retry] 监听到 GENERATION_ENDED，进入检查窗口期...', 'color: #007bff; font-weight: bold;');
    
    // 无论这是初次生成还是重试，我们都要进入检查状态。
    // 如果之前是在重试，现在收到了结果，那么“重试中”的状态结束。
    isRetrying = false; 
    isChecking = true; // 【上锁】

    setTimeout(() => {
        const retryResult = shouldRetry();
        if (retryResult.needRetry) {
            // 如果需要再次重试，performRetry会负责将 isRetrying 设回 true
            performRetry(retryResult.useRegenerate, retryResult.useSwipeRetry);
        } else {
            console.log('%c[Auto Retry] 消息符合要求，本轮监测结束。', 'color: #007bff; font-weight: bold;');
            isChecking = false; // 【解锁】检查通过，解锁
        }
    }, 200);
}


/**
 * 处理用户手动中止生成事件
 */
function handleGenerationStopped() {
    console.log('%c[Auto Retry] 检测到用户手动中止生成。', 'color: #007bff; font-weight: bold;');
    userStoppedGeneration = true;
    isChecking = false; // 如果在检查期间中止，也需要解锁
    isRetrying = false; // 中止也应该取消重试状态
}

/**
 * 处理对话切换事件
 */
function handleChatChanged() {
    console.log('%c[Auto Retry] 检测到对话切换，重置所有状态。', 'color: #007bff; font-weight: bold;');
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
    console.log('%c[Auto Retry] 扩展已初始化 (v4 - 竞争条件修正版)。', 'color: #007bff; font-weight: bold;');
});