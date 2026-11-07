import express from 'express';

/**
 * A backend's routes with its generation handler at `path`, which the app reaches only through /api/generation.
 * @param {import('express').Router} router
 * @param {import('express').RequestHandler} generate
 * @param {string} [path]
 * @returns {import('express').Router}
 */
export function routerWithGenerate(router, generate, path = '/generate') {
    const withGenerate = express.Router();
    withGenerate.post(path, generate);
    withGenerate.use(router);
    return withGenerate;
}
