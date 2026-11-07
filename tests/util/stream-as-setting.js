import { writeSettingsKeys } from '../../src/settings-store.js';

/**
 * Whether a reply streams is a stored setting the server reads. Tests that ask for a streamed or a whole reply per
 * request store it before the request reaches the route.
 * @returns {import('express').RequestHandler}
 */
export function streamAsSetting() {
    return async (request, _response, next) => {
        const body = request.body;
        const asked = typeof body?.stream === 'boolean' ? body.stream : (typeof body?.streaming === 'boolean' ? body.streaming : undefined);
        if (asked !== undefined && (body.owner_id || body.character_avatar || body.group_id)) {
            await writeSettingsKeys(request.user.directories, {
                'textgenerationwebui_settings.streaming': asked,
                'oai_settings.stream_openai': asked,
                'kai_settings.streaming_kobold': asked,
                'nai_settings.streaming_novel': asked,
            });
        }
        next();
    };
}
