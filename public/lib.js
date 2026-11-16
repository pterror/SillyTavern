/**
 * Add all the libraries that you want to expose to the client here.
 * They are bundled and exposed by Webpack in the /lib.js file.
 */
import Fuse from 'fuse.js';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import localforage from 'localforage';
import Handlebars from 'handlebars';
import css from '@adobe/css-tools';
import Bowser from 'bowser';
import DiffMatchPatch from 'diff-match-patch';
import { isProbablyReaderable, Readability } from '@mozilla/readability';
import { reader } from '@pterror/interact-editor/reader';
import { GFM, parser as markdownParser } from '@lezer/markdown';
import { NodeType, Parser, Tree, parseMixed } from '@lezer/common';
import { parser as htmlParser } from '@lezer/html';
import { definitionOf, gfmLook, htmlLook, markdownLook } from '@pterror/interact-markdown/look';
import moment from 'moment';
import seedrandom from 'seedrandom';
import * as Popper from '@popperjs/core';
import droll from 'droll';
import * as chevrotain from 'chevrotain';
import { gzip } from 'fflate';
import { sha256 } from 'js-sha256';

export {
    Fuse,
    DOMPurify,
    hljs,
    localforage,
    Handlebars,
    css,
    Bowser,
    DiffMatchPatch,
    Readability,
    isProbablyReaderable,
    reader,
    markdownParser,
    GFM,
    htmlParser,
    parseMixed,
    Parser,
    Tree,
    NodeType,
    markdownLook,
    gfmLook,
    htmlLook,
    definitionOf,
    moment,
    seedrandom,
    Popper,
    droll,
    chevrotain,
    gzip,
    sha256,
};
