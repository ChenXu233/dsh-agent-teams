/**
 * Control decisions for the member composer (plan 10, task 8).
 *
 * Every function here is pure so the behaviour can be pinned by tests without a
 * browser: the component only renders what these decide, and the transport is
 * the plugin's own `/member/*` routes.
 * @module dsh-agent-teams/client/member-controls
 */
/** Caption used when the member has no resolved model route. */
export const MODEL_PLACEHOLDER = '默认模型';
/**
 * A running member can take the line inside its current step; an idle one gets
 * it as its next turn. An archived team takes neither, so it stays on the safe
 * value the transport defaults to.
 * @param view - live member state.
 */
export function deliveryMode(view) {
    return view.running === true && view.archived !== true ? 'steer' : 'queue';
}
/** Whether the stop control applies to the current state. */
export function stopEnabled(view) {
    return view.running === true && view.archived !== true;
}
/**
 * Whether an attachment could be added. Archived members refuse input, and a
 * running member would receive the image in the middle of a step, so only a
 * live idle member accepts one.
 */
export function canAttach(view) {
    return view.live === true && view.archived !== true && view.running !== true;
}
/** Short model caption for the composer's selector trigger. */
export function modelLabel(view) {
    const model = view.model;
    return model === null || model === undefined ? MODEL_PLACEHOLDER : `${model.provider} / ${model.model}`;
}
/** Queue badge text, or undefined when nothing is waiting. */
export function queuedLabel(queued) {
    if (queued === undefined || queued <= 0)
        return undefined;
    return `${queued} 条待处理`;
}
/** Delivery hint shown under the input. */
export function deliveryHint(view) {
    if (view.archived === true)
        return '已归档：历史可查看，输入已禁用。';
    return deliveryMode(view) === 'steer'
        ? '成员正在运行：发送会插入当前回合。'
        : '成员空闲：发送会作为下一回合处理。';
}
/** Build the select value of one route. */
export function modelOptionKey(provider, model) {
    return `${provider}\u0000${model}`;
}
/**
 * Flatten the host catalog into select options, dropping duplicate routes.
 * @param groups - provider groups from the model directory.
 */
export function modelOptions(groups) {
    const seen = new Set();
    const options = [];
    for (const group of groups ?? []) {
        for (const model of group.models) {
            const key = modelOptionKey(group.id, model.id);
            if (seen.has(key))
                continue;
            seen.add(key);
            options.push({
                key,
                provider: group.id,
                model: model.id,
                label: `${group.name} / ${model.name}`,
                short: model.name,
            });
        }
    }
    return options;
}
/**
 * Keep the member's current route selectable even when the catalog no longer
 * lists it, so the selector never silently shows a different model.
 * @param options - catalog options.
 * @param view - live member state.
 */
export function withCurrentOption(options, view) {
    const model = view.model;
    if (model === null || model === undefined)
        return [...options];
    const key = modelOptionKey(model.provider, model.model);
    if (options.some(option => option.key === key))
        return [...options];
    return [{
            key,
            provider: model.provider,
            model: model.model,
            label: modelLabel(view),
            short: model.model,
        }, ...options];
}
