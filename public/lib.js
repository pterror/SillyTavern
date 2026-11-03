/**
 * Add all the libraries that you want to expose to the client here.
 * They are bundled and exposed by Webpack in the /lib.js file.
 */
import lodash from 'lodash';
import Fuse from 'fuse.js';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import localforage from 'localforage';
import Handlebars from 'handlebars';
import css from '@adobe/css-tools';
import Bowser from 'bowser';
import DiffMatchPatch from 'diff-match-patch';
import { isProbablyReaderable, Readability } from '@mozilla/readability';
import showdown from 'showdown';
import { Marked } from 'marked';
import moment from 'moment';
import seedrandom from 'seedrandom';
import * as Popper from '@popperjs/core';
import droll from 'droll';
import morphdom from 'morphdom';
import * as chevrotain from 'chevrotain';
import { gzip } from 'fflate';
import { sha256 } from 'js-sha256';

export {
    lodash,
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
    showdown,
    Marked,
    moment,
    seedrandom,
    Popper,
    droll,
    morphdom,
    chevrotain,
    gzip,
    sha256,
};
