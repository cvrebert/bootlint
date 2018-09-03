/*!
 * Bootlint - an HTML linter for Bootstrap projects
 * https://github.com/twbs/bootlint
 * Copyright (c) 2014-2018 The Bootlint Authors
 * Licensed under the MIT License.
 */

var cheerio = require('cheerio');
var parseUrl = require('url').parse;
var semver = require('semver');
var voidElements = require('void-elements');
var _location = require('./location');
var LocationIndex = _location.LocationIndex;

(function (exports) {
    'use strict';
    var NUM_COLS = 12;
    var COL_REGEX = /\bcol(?:-(sm|md|lg|xl))?(?:-(auto|\d{1,2}))?\b/;
    var COL_REGEX_G = /\bcol(?:-(sm|md|lg|xl))?(?:-(auto|\d{1,2}))?\b/g;
    var COL_CLASSES = [];
    var SCREENS = ['', 'sm', 'md', 'lg', 'xl'];
    SCREENS.forEach(function (screen) {
        for (var n = -1; n <= NUM_COLS; n++) {
            COL_CLASSES.push('.col' + (screen && '-' + screen) + (n < 0 ? '' : '-' + (n || 'auto')));
        }
    });
    var SCREEN2NUM = {
        '': 0,
        'sm': 1,
        'md': 2,
        'lg': 3,
        'xl': 4
    };
    var NUM2SCREEN = ['', 'sm', 'md', 'lg', 'xl'];
    var IN_NODE_JS = Boolean(cheerio.load);
    var MIN_JQUERY_VERSION = '3.0.0';
    var CURRENT_BOOTSTRAP_VERSION = '4.0.0-beta';
    var PLUGINS = [
        'alert',
        'button',
        'carousel',
        'collapse',
        'dropdown',
        'modal',
        'popover',
        'scrollspy',
        'tab',
        'tooltip'
    ];
    var BOOTSTRAP_FILES = [
        'link[rel="stylesheet"][href$="/bootstrap.css"]',
        'link[rel="stylesheet"][href="bootstrap.css"]',
        'link[rel="stylesheet"][href$="/bootstrap.min.css"]',
        'link[rel="stylesheet"][href="bootstrap.min.css"]',
        'script[src$="/bootstrap.js"]',
        'script[src="bootstrap.js"]',
        'script[src$="/bootstrap.min.js"]',
        'script[src="bootstrap.min.js"]'
    ].join(',');
    var WIKI_URL = 'https://github.com/twbs/bootlint/wiki/';

    function compareNums(a, b) {
        return a - b;
    }

    function isDoctype(node) {
        return node.type === 'directive' && node.name === '!doctype';
    }

    var tagNameOf = IN_NODE_JS ?
        function (element) {
            return element.name.toUpperCase();
        } :
        function (element) {
            /* @covignore */
            return element.tagName.toUpperCase();
        };

    function filenameFromUrl(url) {
        var filename = url.replace(/[#?].*$/, ''); // strip querystring & fragment ID
        var lastSlash = filename.lastIndexOf('/');
        if (lastSlash !== -1) {
            filename = filename.slice(lastSlash + 1);
        }
        return filename;
    }

    function withoutClass(classes, klass) {
        return classes.replace(new RegExp('\\b' + klass + '\\b', 'g'), '');
    }

    function columnClassKey(colClass) {
        return SCREEN2NUM[COL_REGEX.exec(colClass)[1]];
    }

    function compareColumnClasses(a, b) {
        return columnClassKey(a) - columnClassKey(b);
    }

    /**
     * Moves any grid column classes to the end of the class string and sorts the grid classes by ascending screen size.
     * @param {string} classes The "class" attribute of a DOM node
     * @returns {string} The processed "class" attribute value
     */
    function sortedColumnClasses(classes) {
        // extract column classes
        var colClasses = [];
        while (true) {
            var match = COL_REGEX.exec(classes);
            if (!match) {
                break;
            }
            var colClass = match[0];
            colClasses.push(colClass);
            classes = withoutClass(classes, colClass);
        }

        colClasses.sort(compareColumnClasses);
        return classes + ' ' + colClasses.join(' ');
    }

    /**
     * @param {string} classes The "class" attribute of a DOM node
     * @returns {Object.<string, integer[]>} Object mapping grid column widths (1 thru 12) to sorted arrays of screen size numbers (see SCREEN2NUM)
     *      Widths not used in the classes will not have an entry in the object.
     */
    function width2screensFor(classes) {
        var width = null;
        var width2screens = {};
        while (true) {
            var match = COL_REGEX_G.exec(classes);
            if (!match) {
                break;
            }
            var screen = match[1] || '';
            width = match[2] || ''; // can also be 'auto'
            var screens = width2screens[width];
            if (!screens) {
                screens = width2screens[width] = [];
            }
            screens.push(SCREEN2NUM[screen]);
        }

        for (width in width2screens) {
            if (width2screens.hasOwnProperty(width)) {
                width2screens[width].sort(compareNums);
            }
        }

        return width2screens;
    }

    /**
     * Given a sorted array of integers, this finds all contiguous runs where each item is incremented by 1 from the next.
     * For example:
     *      [0, 2, 3, 5] has one such run: [2, 3]
     *      [0, 2, 3, 4, 6, 8, 9, 11] has two such runs: [2, 3, 4], [8, 9]
     *      [0, 2, 4] has no runs.
     * @param {integer[]} list Sorted array of integers
     * @returns {Array.<Array.<integer>>} Array of pairs of start and end values of runs
     */
    function incrementingRunsFrom(list) {
        list = list.concat([Infinity]);// use Infinity to ensure any nontrivial (length >= 2) run ends before the end of the loop
        var runs = [];
        var start = null;
        var prev = null;
        for (var i = 0; i < list.length; i++) {
            var current = list[i];
            if (start === null) {
                // first element starts a trivial run
                start = current;
            } else if (prev + 1 !== current) {
                // run ended
                if (start !== prev) {
                    // run is nontrivial
                    runs.push([start, prev]);
                }
                // start new run
                start = current;
            }
            // else: the run continues

            prev = current;
        }
        return runs;
    }

    /**
     * @returns {(Window|null)} The browser window object, or null if this is not running in a browser environment
     */
    function getBrowserWindowObject() {
        var theWindow = null;
        try {
            /* eslint-disable no-undef, block-scoped-var */
            theWindow = window;
            /* eslint-enable no-undef, block-scoped-var */
        } catch (e) {
            // deliberately do nothing
            // empty
        }

        return theWindow;
    }

    function versionsIn(strings) {
        return strings.map(function (str) {
            var match = str.match(/^\d+\.\d+\.\d+$/);
            return match ? match[0] : null;
        }).filter(function (match) {
            return match !== null;
        });
    }

    function versionInLinkedElement($, element) {
        var elem = $(element);
        var urlAttr = tagNameOf(element) === 'LINK' ? 'href' : 'src';
        var pathSegments = parseUrl(elem.attr(urlAttr)).pathname.split('/');
        var versions = versionsIn(pathSegments);
        if (!versions.length) {
            return null;
        }
        var version = versions[versions.length - 1];
        return version;
    }

    function jqueryPluginVersions(jQuery) {
        /* @covignore */
        return PLUGINS.map(function (pluginName) {
            var plugin = jQuery.fn[pluginName];
            if (!plugin) {
                return undefined;
            }
            var constructor = plugin.Constructor;
            if (!constructor) {
                return undefined;
            }
            return constructor.VERSION;
        }).filter(function (version) {
            return typeof version !== 'undefined';
        }).sort(semver.compare);
    }

    function bootstrapScriptsIn($) {
        var longhands = $('script[src*="bootstrap.js"]').filter(function (i, script) {
            var url = $(script).attr('src');
            var filename = filenameFromUrl(url);
            return filename === 'bootstrap.js';
        });
        var minifieds = $('script[src*="bootstrap.min.js"]').filter(function (i, script) {
            var url = $(script).attr('src');
            var filename = filenameFromUrl(url);
            return filename === 'bootstrap.min.js';
        });

        return {
            longhands: longhands,
            minifieds: minifieds
        };
    }

    /**
     * @param {integer} id Unique string ID for this type of lint error. Of the form "E###" (e.g. "E123").
     * @param {string} message Human-readable string describing the error
     * @param {jQuery} elements jQuery or Cheerio collection of referenced DOM elements pointing to all problem locations in the document
     * @class
     */
    function LintError(id, message, elements) {
        this.id = id;
        this.url = WIKI_URL + id;
        this.message = message;
        this.elements = elements || cheerio('');
    }
    exports.LintError = LintError;

    /**
     * @param {integer} id Unique string ID for this type of lint warning. Of the form "W###" (e.g. "W123").
     * @param {string} message Human-readable string describing the warning
     * @param {jQuery} elements jQuery or Cheerio collection of referenced DOM elements pointing to all problem locations in the document
     * @class
     */
    function LintWarning(id, message, elements) {
        this.id = id;
        this.url = WIKI_URL + id;
        this.message = message;
        this.elements = elements || cheerio('');
    }
    exports.LintWarning = LintWarning;

    var allLinters = {};
    function addLinter(id, linter) {
        if (allLinters[id]) {
            /* @covignore */
            throw new Error('Linter already registered with ID: ' + id);
        }

        var Problem = null;
        if (id[0] === 'E') {
            Problem = LintError;
        } else if (id[0] === 'W') {
            Problem = LintWarning;
        } else {
            /* @covignore */
            throw new Error('Invalid linter ID: ' + id);
        }

        function linterWrapper($, reporter) {
            function specializedReporter(message, elements) {
                reporter(new Problem(id, message, elements));
            }

            linter($, specializedReporter);
        }

        linterWrapper.id = id;
        allLinters[id] = linterWrapper;
    }


    addLinter('W001', function lintMetaCharsetUtf8($, reporter) {
        var meta = $('head>meta[charset]');
        var charset = meta.attr('charset');
        if (!charset) {
            meta = $([
                'head>meta[http-equiv="Content-Type"][content="text/html; charset=utf-8"]',
                'head>meta[http-equiv="content-type"][content="text/html; charset=utf-8"]',
                'head>meta[http-equiv="Content-Type"][content="text/html; charset=UTF-8"]',
                'head>meta[http-equiv="content-type"][content="text/html; charset=UTF-8"]'
            ].join(','));
            if (!meta.length) {
                reporter('`<head>` is missing UTF-8 charset `<meta>` tag');
            }
        } else if (charset.toLowerCase() !== 'utf-8') {
            reporter('charset `<meta>` tag is specifying a legacy, non-UTF-8 charset', meta);
        }
    });
    addLinter('W003', function lintViewport($, reporter) {
        var meta = $('head>meta[name="viewport"][content]');
        if (!meta.length) {
            reporter('`<head>` is missing viewport `<meta>` tag that enables responsiveness');
        }
    });
    addLinter('W004', function lintRemoteModals($, reporter) {
        var remoteModalTriggers = $('[data-toggle="modal"][data-remote]');
        if (remoteModalTriggers.length) {
            reporter('Found one or more modals using the removed `remote` option', remoteModalTriggers);
        }
    });
    addLinter('W005', function lintJquery($, reporter) {
        var OLD_JQUERY = 'Found what might be an outdated version of jQuery; Bootstrap requires jQuery v' + MIN_JQUERY_VERSION + ' or higher';
        var NO_JQUERY_BUT_BS_JS = 'Unable to locate jQuery, which is required for Bootstrap\'s JavaScript plugins to work';
        var NO_JQUERY_NOR_BS_JS = 'Unable to locate jQuery, which is required for Bootstrap\'s JavaScript plugins to work; however, you might not be using Bootstrap\'s JavaScript';
        var bsScripts = bootstrapScriptsIn($);
        var hasBsJs = Boolean(bsScripts.minifieds.length || bsScripts.longhands.length);
        var theWindow = null;
        try {
            /* eslint-disable no-undef, block-scoped-var */
            theWindow = window;
            /* eslint-enable no-undef, block-scoped-var */
        } catch (e) {
            // deliberately do nothing
            // empty
        }
        /* @covignore */
        if (theWindow) {
            // check browser global jQuery
            var globaljQuery = theWindow.$ || theWindow.jQuery;
            if (globaljQuery) {
                var globalVersion = null;
                try {
                    globalVersion = globaljQuery.fn.jquery.split(' ')[0];
                } catch (e) {
                    // skip; not actually jQuery?
                    // empty
                }
                if (globalVersion) {
                    // pad out short version numbers (e.g. '1.7')
                    while (globalVersion.match(/\./g).length < 2) {
                        globalVersion += '.0';
                    }

                    var upToDate = null;
                    try {
                        upToDate = semver.gte(globalVersion, MIN_JQUERY_VERSION, true);
                    } catch (e) {
                        // invalid version number
                        // empty
                    }
                    if (upToDate === false) {
                        reporter(OLD_JQUERY);
                    }
                    if (upToDate !== null) {
                        return;
                    }
                }
            }
        }

        // check for jQuery <script>s
        var jqueries = $([
            'script[src*="jquery"]',
            'script[src*="jQuery"]'
        ].join(','));
        if (!jqueries.length) {
            reporter(hasBsJs ? NO_JQUERY_BUT_BS_JS : NO_JQUERY_NOR_BS_JS);
            return;
        }
        jqueries.each(function () {
            var script = $(this);
            var pathSegments = parseUrl(script.attr('src')).pathname.split('/');
            var filename = pathSegments[pathSegments.length - 1];
            if (!/^j[qQ]uery(\.min)?\.js$/.test(filename)) {
                return;
            }
            var versions = versionsIn(pathSegments);
            if (!versions.length) {
                return;
            }
            var version = versions[versions.length - 1];
            if (!semver.gte(version, MIN_JQUERY_VERSION, true)) {
                reporter(OLD_JQUERY, script);
            }
        });
    });
    addLinter('W006', function lintTooltipsOnDisabledElems($, reporter) {
        var selector = [
            '[disabled][data-toggle="tooltip"]',
            '.disabled[data-toggle="tooltip"]',
            '[disabled][data-toggle="popover"]',
            '.disabled[data-toggle="popover"]'
        ].join(',');
        var disabledWithTooltips = $(selector);
        if (disabledWithTooltips.length) {
            reporter(
                'Tooltips and popovers on disabled elements cannot be triggered by user interaction unless the element becomes enabled.' +
                ' To have tooltips and popovers be triggerable by the user even when their associated element is disabled,' +
                ' put the disabled element inside a wrapper `<div>` and apply the tooltip or popover to the wrapper `<div>` instead.',
                disabledWithTooltips
            );
        }
    });
    addLinter('W007', function lintBtnType($, reporter) {
        var badBtnType = $('button:not([type="submit"], [type="reset"], [type="button"])');
        if (badBtnType.length) {
            reporter('Found one or more `<button>`s missing a `type` attribute.', badBtnType);
        }
    });
    addLinter('W008', function lintTooltipsInBtnGroups($, reporter) {
        // TODO: what about input groups?
        var nonBodyContainers = $('.btn-group [data-toggle="tooltip"]:not([data-container="body"]), .btn-group [data-toggle="popover"]:not([data-container="body"])');
        if (nonBodyContainers.length) {
            reporter('Tooltips and popovers within button groups should have their `container` set to `\'body\'`. Found tooltips/popovers that might lack this setting.', nonBodyContainers);
        }
    });
    addLinter('W009', function lintEmptySpacerCols($, reporter) {
        var selector = COL_CLASSES.map(function (colClass) {
            return colClass + ':not(:last-child)';
        }).join(',');
        var columns = $(selector);
        columns.each(function (_index, col) {
            var column = $(col);
            var isVoidElement = voidElements[col.tagName.toLowerCase()];
            // can't just use :empty because :empty excludes nodes with all-whitespace text content
            var hasText = Boolean(column.text().trim().length);
            var hasChildren = Boolean(column.children(':first-child').length);
            if (hasChildren || hasText || isVoidElement) {
                return;
            }

            reporter('Using empty spacer columns isn\'t necessary with Bootstrap\'s grid.', column);
        });
    });
    addLinter('W013', function lintOutdatedBootstrap($, reporter) {
        var OUTDATED_BOOTSTRAP = 'Bootstrap version does not seem to match the version this bootlint version is for (' + CURRENT_BOOTSTRAP_VERSION + '); saw what appears to be usage of Bootstrap ';
        var theWindow = getBrowserWindowObject();
        var globaljQuery = theWindow && (theWindow.$ || theWindow.jQuery);
        /* @covignore */
        if (globaljQuery) {
            var versions = jqueryPluginVersions(globaljQuery);
            if (versions.length) {
                var minVersion = versions[0];
                if (semver.lt(minVersion, CURRENT_BOOTSTRAP_VERSION, true)) {
                    reporter(OUTDATED_BOOTSTRAP + minVersion);
                    return;
                }
            }
        }
        // check for Bootstrap <link>s and <script>s
        var bootstraps = $(BOOTSTRAP_FILES);
        bootstraps.each(function () {
            var version = versionInLinkedElement($, this);
            if (version === null) {
                return;
            }
            if (semver.lt(version, CURRENT_BOOTSTRAP_VERSION, true)) {
                reporter(OUTDATED_BOOTSTRAP + version, $(this));
            }
        });
    });
    addLinter('W014', function lintCarouselControls($, reporter) {
        // TODO: adapt for BS4
        var controls = $('.carousel-indicators > li, .carousel-control');
        controls.each(function (_index, cont) {
            var control = $(cont);
            var target = control.attr('href') || control.attr('data-target');
            var carousel = $(target);

            if (!carousel.length || carousel.is(':not(.carousel)')) {
                reporter('Carousel controls and indicators should use `href` or `data-target` to reference an element with class `.carousel`.', control);
            }
        });
    });
    addLinter('W016', function lintDisabledClassOnButton($, reporter) {
        var btnsWithDisabledClass = $('button.btn.disabled, input.btn.disabled');
        if (btnsWithDisabledClass.length) {
            reporter('Using the `.disabled` class on a `<button>` or `<input>` only changes the appearance of the element. It doesn\'t prevent the user from interacting with the element (for example, clicking on it or focusing it). If you want to truly disable the element, use the `disabled` attribute instead.', btnsWithDisabledClass);
        }
    });
    addLinter('W017', function lintInputsMissingTypeAttr($, reporter) {
        var inputsMissingTypeAttr = $('input:not([type])');
        if (inputsMissingTypeAttr.length) {
            reporter('Found one or more `<input>`s missing a `type` attribute.', inputsMissingTypeAttr);
        }
    });
    addLinter('W901', function bs3ClassUsed($, reporter) {
        var bs3Classes = [
            'affix',
            'alert-dismissable',
            'blockquote-reverse',
            'bottom',
            'bottom-left',
            'bottom-right',
            'btn-default',
            'btn-group-justified',
            'btn-group-xs',
            'btn-xs',
            'caption',
            'caret',
            'carousel-control',
            'center-block',
            'checkbox',
            'checkbox-inline',
            'col-lg-offset-0',
            'col-lg-offset-1',
            'col-lg-offset-2',
            'col-lg-offset-3',
            'col-lg-offset-4',
            'col-lg-offset-5',
            'col-lg-offset-6',
            'col-lg-offset-7',
            'col-lg-offset-8',
            'col-lg-offset-9',
            'col-lg-offset-10',
            'col-lg-offset-11',
            'col-lg-offset-12',
            'col-lg-pull-0',
            'col-lg-pull-1',
            'col-lg-pull-2',
            'col-lg-pull-3',
            'col-lg-pull-4',
            'col-lg-pull-5',
            'col-lg-pull-6',
            'col-lg-pull-7',
            'col-lg-pull-8',
            'col-lg-pull-9',
            'col-lg-pull-10',
            'col-lg-pull-11',
            'col-lg-pull-12',
            'col-lg-push-0',
            'col-lg-push-1',
            'col-lg-push-2',
            'col-lg-push-3',
            'col-lg-push-4',
            'col-lg-push-5',
            'col-lg-push-6',
            'col-lg-push-7',
            'col-lg-push-8',
            'col-lg-push-9',
            'col-lg-push-10',
            'col-lg-push-11',
            'col-lg-push-12',
            'col-md-offset-0',
            'col-md-offset-1',
            'col-md-offset-2',
            'col-md-offset-3',
            'col-md-offset-4',
            'col-md-offset-5',
            'col-md-offset-6',
            'col-md-offset-7',
            'col-md-offset-8',
            'col-md-offset-9',
            'col-md-offset-10',
            'col-md-offset-11',
            'col-md-offset-12',
            'col-md-pull-0',
            'col-md-pull-1',
            'col-md-pull-2',
            'col-md-pull-3',
            'col-md-pull-4',
            'col-md-pull-5',
            'col-md-pull-6',
            'col-md-pull-7',
            'col-md-pull-8',
            'col-md-pull-9',
            'col-md-pull-10',
            'col-md-pull-11',
            'col-md-pull-12',
            'col-md-push-0',
            'col-md-push-1',
            'col-md-push-2',
            'col-md-push-3',
            'col-md-push-4',
            'col-md-push-5',
            'col-md-push-6',
            'col-md-push-7',
            'col-md-push-8',
            'col-md-push-9',
            'col-md-push-10',
            'col-md-push-11',
            'col-md-push-12',
            'col-sm-offset-0',
            'col-sm-offset-1',
            'col-sm-offset-2',
            'col-sm-offset-3',
            'col-sm-offset-4',
            'col-sm-offset-5',
            'col-sm-offset-6',
            'col-sm-offset-7',
            'col-sm-offset-8',
            'col-sm-offset-9',
            'col-sm-offset-10',
            'col-sm-offset-11',
            'col-sm-offset-12',
            'col-sm-pull-0',
            'col-sm-pull-1',
            'col-sm-pull-2',
            'col-sm-pull-3',
            'col-sm-pull-4',
            'col-sm-pull-5',
            'col-sm-pull-6',
            'col-sm-pull-7',
            'col-sm-pull-8',
            'col-sm-pull-9',
            'col-sm-pull-10',
            'col-sm-pull-11',
            'col-sm-pull-12',
            'col-sm-push-0',
            'col-sm-push-1',
            'col-sm-push-2',
            'col-sm-push-3',
            'col-sm-push-4',
            'col-sm-push-5',
            'col-sm-push-6',
            'col-sm-push-7',
            'col-sm-push-8',
            'col-sm-push-9',
            'col-sm-push-10',
            'col-sm-push-11',
            'col-sm-push-12',
            'col-xs-1',
            'col-xs-2',
            'col-xs-3',
            'col-xs-4',
            'col-xs-5',
            'col-xs-6',
            'col-xs-7',
            'col-xs-8',
            'col-xs-9',
            'col-xs-10',
            'col-xs-11',
            'col-xs-12',
            'col-xs-offset-0',
            'col-xs-offset-1',
            'col-xs-offset-2',
            'col-xs-offset-3',
            'col-xs-offset-4',
            'col-xs-offset-5',
            'col-xs-offset-6',
            'col-xs-offset-7',
            'col-xs-offset-8',
            'col-xs-offset-9',
            'col-xs-offset-10',
            'col-xs-offset-11',
            'col-xs-offset-12',
            'col-xs-pull-0',
            'col-xs-pull-1',
            'col-xs-pull-2',
            'col-xs-pull-3',
            'col-xs-pull-4',
            'col-xs-pull-5',
            'col-xs-pull-6',
            'col-xs-pull-7',
            'col-xs-pull-8',
            'col-xs-pull-9',
            'col-xs-pull-10',
            'col-xs-pull-11',
            'col-xs-pull-12',
            'col-xs-push-0',
            'col-xs-push-1',
            'col-xs-push-2',
            'col-xs-push-3',
            'col-xs-push-4',
            'col-xs-push-5',
            'col-xs-push-6',
            'col-xs-push-7',
            'col-xs-push-8',
            'col-xs-push-9',
            'col-xs-push-10',
            'col-xs-push-11',
            'col-xs-push-12',
            'control-label',
            'danger',
            'divider',
            'dl-horizontal',
            'dropdown-backdrop',
            'dropdown-menu-left',
            'form-control-static',
            'form-group-lg',
            'form-group-sm',
            'form-horizontal',
            'gradient',
            'has-error',
            'has-success',
            'has-warning',
            'help-block',
            'hidden',
            'hidden-lg',
            'hidden-md',
            'hidden-print',
            'hidden-sm',
            'hidden-xs',
            'hide',
            'icon-bar',
            'icon-next',
            'icon-prev',
            'img-circle',
            'img-responsive',
            'img-rounded',
            // 'in',
            // 'info',
            'input-lg',
            'input-sm',
            // 'item',
            'label',
            'label-danger',
            'label-default',
            'label-info',
            'label-primary',
            'label-success',
            'label-warning',
            // 'left',
            'list-group-item-heading',
            'list-group-item-text',
            'media-bottom',
            'media-heading',
            'media-left',
            'media-list',
            'media-middle',
            'media-object',
            'media-right',
            'navbar-btn',
            'navbar-default',
            'navbar-fixed-bottom',
            'navbar-fixed-top',
            'navbar-form',
            'navbar-header',
            'navbar-inverse',
            'navbar-left',
            'navbar-link',
            'navbar-right',
            'navbar-static-top',
            'navbar-toggle',
            'nav-divider',
            'nav-stacked',
            'nav-tabs-justified',
            // 'next',
            // 'open',
            'page-header',
            'pager',
            'panel',
            'panel-body',
            'panel-collapse',
            'panel-danger',
            'panel-default',
            'panel-footer',
            'panel-group',
            'panel-heading',
            'panel-info',
            'panel-primary',
            'panel-success',
            'panel-title',
            'panel-warning',
            'popover-content',
            'popover-title',
            // 'prev',
            // 'previous',
            'progress-bar-danger',
            'progress-bar-info',
            'progress-bar-success',
            'progress-bar-warning',
            'progress-striped',
            'pull-left',
            'pull-right',
            'radio',
            'radio-inline',
            // 'right',
            'row-no-gutters',
            'success',
            'table-condensed',
            'thumbnail',
            'tooltip-arrow',
            // 'top',
            // 'top-left',
            // 'top-right',
            'visible-lg',
            'visible-lg-block',
            'visible-lg-inline',
            'visible-lg-inline-block',
            'visible-md',
            'visible-md-block',
            'visible-md-inline',
            'visible-md-inline-block',
            'visible-print',
            'visible-print-block',
            'visible-print-inline',
            'visible-print-inline-block',
            'visible-sm',
            'visible-sm-block',
            'visible-sm-inline',
            'visible-sm-inline-block',
            'visible-xs',
            'visible-xs-block',
            'visible-xs-inline',
            'visible-xs-inline-block',
            'warning',
            'well',
            'well-lg',
            'well-sm'
        ];
        var bs3ClassesSelector = bs3Classes.map(function (x) {
            return '.' + x;
        }).join();
        var bs3ClassUsage = $(bs3ClassesSelector);
        if (bs3ClassUsage.length) {
            reporter('Found usage of CSS classes specific to Bootstrap 3.', bs3ClassUsage);
        }
    });

    addLinter('E001', (function () {
        var MISSING_DOCTYPE = 'Document is missing a DOCTYPE declaration';
        var NON_HTML5_DOCTYPE = 'Document declares a non-HTML5 DOCTYPE';
        if (IN_NODE_JS) {
            return function lintDoctype($, reporter) {
                var doctype = $(':root')[0];
                while (doctype && !isDoctype(doctype)) {
                    doctype = doctype.prev;
                }
                if (!doctype) {
                    reporter(MISSING_DOCTYPE);
                    return;
                }
                var doctypeId = doctype.data.toLowerCase();
                if (doctypeId !== '!doctype html' && doctypeId !== '!doctype html system "about:legacy-compat"') {
                    reporter(NON_HTML5_DOCTYPE);
                }
            };
        }

        /* @covignore */
        return function lintDoctype($, reporter) {
            /* eslint-disable no-undef, block-scoped-var */
            var doc = window.document;
            /* eslint-enable un-undef, block-scoped-var */
            if (doc.doctype === null) {
                reporter(MISSING_DOCTYPE);
            } else if (doc.doctype.publicId) {
                reporter(NON_HTML5_DOCTYPE);
            } else if (doc.doctype.systemId && doc.doctype.systemId !== 'about:legacy-compat') {
                reporter(NON_HTML5_DOCTYPE);
            }
        };

    })());
    addLinter('E003', function lintContainers($, reporter) {
        var notAnyColClass = COL_CLASSES.map(function (colClass) {
            return ':not(' + colClass + ')';
        }).join('');
        var selector = '*' + notAnyColClass + '>.row';
        var rowsOutsideColumns = $(selector);
        var rowsOutsideColumnsAndContainers = rowsOutsideColumns.filter(function () {
            var parent = $(this).parent();
            while (parent.length) {
                if (parent.is('.container, .container-fluid')) {
                    return false;
                }
                parent = $(parent).parent();
            }
            return true;
        });
        if (rowsOutsideColumnsAndContainers.length) {
            reporter('Found one or more `.row`s that were not children of a grid column or descendants of a `.container` or `.container-fluid`', rowsOutsideColumnsAndContainers);
        }
    });
    addLinter('E005', function lintRowAndColOnSameElem($, reporter) {
        var selector = COL_CLASSES.map(function (col) {
            return '.row' + col;
        }).join(',');

        var rowCols = $(selector);
        if (rowCols.length) {
            reporter('Found both `.row` and `.col*` used on the same element', rowCols);
        }
    });
    addLinter('E006', function lintInputGroupFormControlTypes($, reporter) {
        var selectInputGroups = $('.input-group select');
        if (selectInputGroups.length) {
            reporter('`.input-group` contains a `<select>`; only text-based `<input>`s are permitted in an `.input-group`', selectInputGroups);
        }
        var textareaInputGroups = $('.input-group textarea');
        if (textareaInputGroups.length) {
            reporter('`.input-group` contains a `<textarea>`; only text-based `<input>`s are permitted in an `.input-group`', textareaInputGroups);
        }
    });
    addLinter('E007', function lintBootstrapJs($, reporter) {
        var scripts = bootstrapScriptsIn($);
        if (scripts.longhands.length && scripts.minifieds.length) {
            reporter('Only one copy of Bootstrap\'s JS should be included; currently the webpage includes both bootstrap.js and bootstrap.min.js', scripts.longhands.add(scripts.minifieds));
        }
    });
    addLinter('E009', function lintMissingInputGroupSizes($, reporter) {
        var selector = [
            '.input-group:not(.input-group-lg) .btn-lg',
            '.input-group:not(.input-group-sm) .btn-sm'
        ].join(',');
        var badInputGroupSizing = $(selector);
        if (badInputGroupSizing.length) {
            reporter('Button and input sizing within `.input-group`s can cause issues. Instead, use input group sizing classes `.input-group-lg` or `.input-group-sm`', badInputGroupSizing);
        }
    });
    addLinter('E010', function lintMultipleFormControlsInInputGroup($, reporter) {
        var badInputGroups = $('.input-group').filter(function (i, inputGroup) {
            return $(inputGroup).find('.form-control').length > 1;
        });
        if (badInputGroups.length) {
            reporter('Input groups cannot contain multiple `.form-control`s', badInputGroups);
        }
    });
    addLinter('E011', function lintFormGroupMixedWithInputGroup($, reporter) {
        var badMixes = $('.input-group.form-group, .input-group.row, .input-group.form-row');
        if (badMixes.length) {
            reporter('`.input-group` and `.form-group`/`.row`/`.form-row` cannot be used directly on the same element. Instead, nest the `.input-group` within the `.form-group`/`.row`/`.form-row`', badMixes);
        }
    });
    addLinter('E012', function lintGridClassMixedWithInputGroup($, reporter) {
        var selector = COL_CLASSES.map(function (colClass) {
            return '.input-group' + colClass;
        }).join(',');

        var badMixes = $(selector);
        if (badMixes.length) {
            reporter('`.input-group` and `.col*` cannot be used directly on the same element. Instead, nest the `.input-group` within the `.col*`', badMixes);
        }
    });
    addLinter('E013', function lintRowChildrenAreCols($, reporter) {
        var ALLOWED_CHILDREN = COL_CLASSES.concat(['script', '.clearfix']);
        var disallowedChildren = ALLOWED_CHILDREN.map(function (colClass) {
            return ':not(' + colClass + ')';
        }).join('');
        var selector = '.row>*' + disallowedChildren + ',.form-row>*' + disallowedChildren;

        var nonColRowChildren = $(selector);
        if (nonColRowChildren.length) {
            reporter('Only columns (`.col*`) or `.clearfix` may be children of `.row`s or `.form-row`s.', nonColRowChildren);
        }
    });
    addLinter('E014', function lintColParentsAreRowsOrFormGroups($, reporter) {
        var selector = COL_CLASSES.map(function (colClass) {
            return '*:not(.row):not(.form-row)>' + colClass + ':not(col):not(th):not(td)';
        }).join(',');

        var colsOutsideRowsAndFormGroups = $(selector);
        if (colsOutsideRowsAndFormGroups.length) {
            reporter('Columns (`.col*`) can only be children of `.row`s or `.form-row`s', colsOutsideRowsAndFormGroups);
        }
    });
    addLinter('E016', function lintBtnToggle($, reporter) {
        var badBtnToggle = $('.btn.dropdown-toggle ~ .btn');
        if (badBtnToggle.length) {
            reporter('`.btn.dropdown-toggle` must be the last button in a button group.', badBtnToggle);
        }
    });
    addLinter('E017', function lintBlockCheckboxes($, reporter) {
        var badCheckboxes = $('.checkbox').filter(function (i, div) {
            return $(div).filter(':has(>label>input[type="checkbox"])').length <= 0;
        });
        if (badCheckboxes.length) {
            reporter('Incorrect markup used with the `.checkbox` class. The correct markup structure is `.checkbox>label>input[type="checkbox"]`', badCheckboxes);
        }
    });
    addLinter('E018', function lintBlockRadios($, reporter) {
        var badRadios = $('.radio').filter(function (i, div) {
            return $(div).filter(':has(>label>input[type="radio"])').length <= 0;
        });
        if (badRadios.length) {
            reporter('Incorrect markup used with the `.radio` class. The correct markup structure is `.radio>label>input[type="radio"]`', badRadios);
        }
    });
    addLinter('E019', function lintInlineCheckboxes($, reporter) {
        var wrongElems = $('.checkbox-inline:not(label)');
        if (wrongElems.length) {
            reporter('`.checkbox-inline` should only be used on `<label>` elements', wrongElems);
        }
        var badStructures = $('.checkbox-inline').filter(function (i, label) {
            return $(label).children('input[type="checkbox"]').length <= 0;
        });
        if (badStructures.length) {
            reporter('Incorrect markup used with the `.checkbox-inline` class. The correct markup structure is `label.checkbox-inline>input[type="checkbox"]`', badStructures);
        }
    });
    addLinter('E020', function lintInlineRadios($, reporter) {
        var wrongElems = $('.radio-inline:not(label)');
        if (wrongElems.length) {
            reporter('`.radio-inline` should only be used on `<label>` elements', wrongElems);
        }
        var badStructures = $('.radio-inline').filter(function (i, label) {
            return $(label).children('input[type="radio"]').length <= 0;
        });
        if (badStructures.length) {
            reporter('Incorrect markup used with the `.radio-inline` class. The correct markup structure is `label.radio-inline>input[type="radio"]`', badStructures);
        }
    });
    addLinter('E021', function lintButtonsCheckedActive($, reporter) {
        var selector = [
            '[data-toggle="buttons"]>label:not(.active)>input[type="checkbox"][checked]',
            '[data-toggle="buttons"]>label.active>input[type="checkbox"]:not([checked])',
            '[data-toggle="buttons"]>label:not(.active)>input[type="radio"][checked]',
            '[data-toggle="buttons"]>label.active>input[type="radio"]:not([checked])'
        ].join(',');
        var mismatchedButtonInputs = $(selector);
        if (mismatchedButtonInputs.length) {
            reporter('`.active` class used without the `checked` attribute (or vice-versa) in a button group using the button.js plugin', mismatchedButtonInputs);
        }
    });
    addLinter('E022', function lintModalsWithinOtherComponents($, reporter) {
        var selector = [
            '.table .modal',
            '.navbar .modal'
        ].join(',');
        var badNestings = $(selector);
        if (badNestings.length) {
            reporter('Modal markup should not be placed within other components, so as to avoid the component\'s styles interfering with the modal\'s appearance or functionality', badNestings);
        }
    });
    addLinter('E023', function lintCardBodyWithoutCard($, reporter) {
        var badPanelBody = $('.card-body').filter(function () {
            return $(this).closest('.card').length !== 1;
        });
        if (badPanelBody.length) {
            reporter('`.card-body` must have `.card` or have it as an ancestor.', badPanelBody);
        }
    });
    addLinter('E024', function lintCardHeadingWithoutCard($, reporter) {
        var badPanelHeading = $('.card-header').filter(function () {
            return $(this).parents('.card').length !== 1;
        });
        if (badPanelHeading.length) {
            reporter('`.card-header` must have one `.card` ancestor.', badPanelHeading);
        }
    });
    addLinter('E025', function lintCardFooterWithoutCard($, reporter) {
        var badPanelFooter = $('.card-footer').filter(function () {
            return $(this).parents('.card').length !== 1;
        });
        if (badPanelFooter.length) {
            reporter('`.card-footer` must have one `.card` ancestor.', badPanelFooter);
        }
    });
    addLinter('E026', function lintCardTitleWithoutCard($, reporter) {
        var badPanelTitle = $('.card-title').filter(function () {
            return $(this).parents('.card').length !== 1;
        });
        if (badPanelTitle.length) {
            reporter('`.card-title` must have one `.card` ancestor.', badPanelBody);
        }
    });
    addLinter('E028', function lintFormControlFeedbackWithoutHasFeedback($, reporter) {
        var ancestorsMissingClasses = $('.form-control-feedback').filter(function () {
            return $(this).closest('.form-group.has-feedback').length !== 1;
        });
        if (ancestorsMissingClasses.length) {
            reporter('`.form-control-feedback` must have `.form-group.has-feedback` or have it as an ancestor', ancestorsMissingClasses);
        }
    });
    addLinter('E029', function lintRedundantColumnClasses($, reporter) {
        var columns = $(COL_CLASSES.join(','));
        columns.each(function (_index, col) {
            var column = $(col);
            var classes = column.attr('class');
            var simplifiedClasses = classes;
            var width2screens = width2screensFor(classes);
            var isRedundant = false;
            for (var width in width2screens) {
                if (width2screens.hasOwnProperty(width)) {
                    var screens = width2screens[width];
                    var runs = incrementingRunsFrom(screens);
                    if (!runs.length) {
                        continue;
                    }

                    isRedundant = true;

                    for (var i = 0; i < runs.length; i++) {
                        var run = runs[i];
                        var min = run[0];
                        var max = run[1];

                        // remove redundant classes
                        for (var screenNum = min + 1; screenNum <= max; screenNum++) {
                            var colClass = 'col' + (NUM2SCREEN[screenNum] && '-' + NUM2SCREEN[screenNum]) + (width && '-' + width);
                            simplifiedClasses = withoutClass(simplifiedClasses, colClass);
                        }
                    }
                }
            }
            if (!isRedundant) {
                return;
            }

            simplifiedClasses = sortedColumnClasses(simplifiedClasses);
            simplifiedClasses = simplifiedClasses.replace(/ {2,}/g, ' ').trim();
            var oldClass = '`class="' + classes + '"`';
            var newClass = '`class="' + simplifiedClasses + '"`';
            reporter(
                'Since grid classes apply to devices with screen widths greater than or equal to the breakpoint sizes (unless overridden by grid classes targeting larger screens), ' +
                oldClass + ' is redundant and can be simplified to ' + newClass,
                column
            );
        });
    });
    addLinter('E032', function lintModalStructure($, reporter) {
        var elements;

        elements = $('.modal-dialog').parent(':not(.modal)');
        if (elements.length) {
            reporter('`.modal-dialog` must be a child of `.modal`', elements);
        }

        elements = $('.modal-content').parent(':not(.modal-dialog)');
        if (elements.length) {
            reporter('`.modal-content` must be a child of `.modal-dialog`', elements);
        }

        elements = $('.modal-header').parent(':not(.modal-content)');
        if (elements.length) {
            reporter('`.modal-header` must be a child of `.modal-content`', elements);
        }

        elements = $('.modal-body').parent(':not(.modal-content)');
        if (elements.length) {
            reporter('`.modal-body` must be a child of `.modal-content`', elements);
        }

        elements = $('.modal-footer').parent(':not(.modal-content)');
        if (elements.length) {
            reporter('`.modal-footer` must be a child of `.modal-content`', elements);
        }

        elements = $('.modal-title').parent(':not(.modal-header)');
        if (elements.length) {
            reporter('`.modal-title` must be a child of `.modal-header`', elements);
        }
    });
    addLinter('E033', function lintAlertMissingDismissible($, reporter) {
        var alertsMissingDismissible = $('.alert:not(.alert-dismissible):has([data-dismiss="alert"])');
        if (alertsMissingDismissible.length) {
            reporter('`.alert` with dismiss button must have class `.alert-dismissible`', alertsMissingDismissible);
        }
    });
    addLinter('E035', function lintFormGroupWithFormClass($, reporter) {
        var badFormGroups = $('.form-group.form-inline');
        if (badFormGroups.length) {
            reporter('Neither `.form-inline` should be used directly on a `.form-group`. Instead, nest the `.form-group` within the `.form-inline`.', badFormGroups);
        }
    });
    addLinter('E037', function lintColZeros($, reporter) {
        var selector = SCREENS.map(function (screen) {
            return '.col' + (screen && '-' + screen) + '-0';
        }).join(',');
        var elements = $(selector);
        if (elements.length) {
            reporter('Column widths must be positive integers (and <= 12 by default). Found usage(s) of invalid nonexistent `.col*-0` classes.', elements);
        }
    });
    addLinter('E038', function lintMediaPulls($, reporter) {
        var mediaPullsOutsideMedia = $('.media-left, .media-right').filter(function () {
            return !$(this).parent().closest('.media').length;
        });
        if (mediaPullsOutsideMedia.length) {
            reporter('`.media-left` and `.media-right` should not be used outside of `.media` objects.', mediaPullsOutsideMedia);
        }
    });
    addLinter('E039', function lintNavbarPulls($, reporter) {
        var navbarPullsOutsideNavbars = $('.navbar-left, .navbar-right').filter(function () {
            return !$(this).parent().closest('.navbar').length;
        });
        if (navbarPullsOutsideNavbars.length) {
            reporter('`.navbar-left` and `.navbar-right` should not be used outside of navbars.', navbarPullsOutsideNavbars);
        }
    });
    addLinter('E041', function lintCarouselStructure($, reporter) {
        var carouselsWithWrongInners = $('.carousel').filter(function () {
            return $(this).children('.carousel-inner').length !== 1;
        });
        if (carouselsWithWrongInners.length) {
            reporter('`.carousel` must have exactly one `.carousel-inner` child.', carouselsWithWrongInners);
        }

        var innersWithWrongActiveItems = $('.carousel-inner').filter(function () {
            return $(this).children('.item.active').length !== 1;
        });
        if (innersWithWrongActiveItems.length) {
            reporter('`.carousel-inner` must have exactly one `.item.active` child.', innersWithWrongActiveItems);
        }
    });
    addLinter('E042', function lintFormControlOnWrongControl($, reporter) {
        var formControlsOnWrongTags = $('.form-control:not(input,textarea,select)');
        if (formControlsOnWrongTags.length) {
            reporter('`.form-control` should only be used on `<input>`s, `<textarea>`s, and `<select>`s.', formControlsOnWrongTags);
        }

        var formControlsOnWrongTypes = $('input.form-control:not(' + [
            'color',
            'email',
            'number',
            'password',
            'search',
            'tel',
            'text',
            'url',
            'date',
            'month',
            'week',
            'time'
        ].map(function (type) {
            return '[type="' + type + '"]';
        }).join(',') + ')');
        if (formControlsOnWrongTypes.length) {
            reporter('`.form-control` cannot be used on non-textual `<input>`s, such as those whose `type` is: `file`, `checkbox`, `radio`, `range`, `button`', formControlsOnWrongTypes);
        }
    });
    addLinter('E043', function lintNavbarNavAnchorButtons($, reporter) {
        var navbarNavAnchorBtns = $('.navbar-nav a.btn, .navbar-nav a.navbar-btn');
        if (navbarNavAnchorBtns.length) {
            reporter('Button classes (`.btn`, `.btn-*`, `.navbar-btn`) cannot be used on `<a>`s within `.navbar-nav`s.', navbarNavAnchorBtns);
        }
    });
    addLinter('E044', function lintInputGroupAddonChildren($, reporter) {
        var badInputGroups = $('.input-group').filter(function () {
            var inputGroup = $(this);
            return !inputGroup.children('.form-control').length || !inputGroup.children('.input-group-prepend, .input-group-append').length;
        });
        if (badInputGroups.length) {
            reporter('`.input-group` must have a `.form-control` and either an `.input-group-prepend` or `.input-group-append`.', badInputGroups);
        }
    });
    addLinter('E045', function lintImgFluidOnNonImgs($, reporter) {
        var imgFluidNotOnImg = $('.img-fluid:not(img)');
        if (imgFluidNotOnImg.length) {
            reporter('`.img-fluid` should only be used on `<img>`s', imgFluidNotOnImg);
        }
    });
    addLinter('E046', function lintModalTabIndex($, reporter) {
        var modalsWithoutTabindex = $('.modal:not([tabindex])');
        if (modalsWithoutTabindex.length) {
            reporter('`.modal` elements must have a `tabindex` attribute.', modalsWithoutTabindex);
        }
    });
    addLinter('E047', function lintBtnElements($, reporter) {
        var btns = $('.btn:not(a,button,input,label)');
        if (btns.length) {
            reporter('`.btn` should only be used on `<a>`, `<button>`, `<input>`, or `<label>` elements.', btns);
        }
    });
    addLinter('E048', function lintModalRole($, reporter) {
        var modals = $('.modal:not([role="dialog"])');
        if (modals.length) {
            reporter('`.modal` must have a `role="dialog"` attribute.', modals);
        }
    });
    addLinter('E049', function lintModalDialogRole($, reporter) {
        var modalDialogs = $('.modal-dialog:not([role="document"])');
        if (modalDialogs.length) {
            reporter('`.modal-dialog` must have a `role="document"` attribute.', modalDialogs);
        }
    });
    addLinter('E050', function lintNestedFormGroups($, reporter) {
        var nestedFormGroups = $('.form-group > .form-group');
        if (nestedFormGroups.length) {
            reporter('`.form-group`s should not be nested.', nestedFormGroups);
        }
    });
    addLinter('E051', function lintColumnsNoFloats($, reporter) {
        var pullSelector = COL_CLASSES.map(function (col) {
            return '.float-left' + col + ',.float-right' + col;
        }).join(',');
        var pulledCols = $(pullSelector);
        if (pulledCols.length) {
            reporter('`.float-right` and `.float-left` must not be used on `.col*` elements', pulledCols);
        }
        var styledSelector = COL_CLASSES.map(function (col) {
            return col + '[style]';
        }).join(',');
        var styledCols = $(styledSelector).filter(function (i, el) {
            //test for `float:*` in the style attribute
            return /float\s*:\s*[a-z]+/i.test($(el).attr('style'));
        });
        if (styledCols.length) {
            reporter('Manually added `float` styles must not be added on `.col*` elements', styledCols);
        }
    });
    addLinter('E052', function lintRowsNoFloats($, reporter) {
        var pulledRows = $('.row.float-right, .row.float-left');
        if (pulledRows.length) {
            reporter('`.float-right` and `.float-left` must not be used on `.row` elements', pulledRows);
        }
        var styledRows = $('.row[style]').filter(function (i, el) {
            //test for `float:*` in the style attribute
            return /float\s*:\s*[a-z]+/i.test($(el).attr('style'));
        });
        if (styledRows.length) {
            reporter('Manually added `float` styles must not be added on `.row` elements', styledRows);
        }
    });
    exports._lint = function ($, reporter, disabledIdList, html) {
        var locationIndex = IN_NODE_JS ? new LocationIndex(html) : null;
        var reporterWrapper = IN_NODE_JS ?
            function (problem) {
                if (problem.elements) {
                    problem.elements = problem.elements.each(function (i, element) {
                        if (typeof element.startIndex !== 'undefined') {
                            var location = locationIndex.locationOf(element.startIndex);
                            if (location) {
                                element.startLocation = location;
                            }
                        }
                    });
                }
                reporter(problem);
            } :
            reporter;

        var disabledIdSet = {};
        disabledIdList.forEach(function (disabledId) {
            disabledIdSet[disabledId] = true;
        });
        Object.keys(allLinters).sort().forEach(function (linterId) {
            if (!disabledIdSet[linterId]) {
                allLinters[linterId]($, reporterWrapper);
            }
        });
    };
    /**
     * @callback reporter
     * @param {LintWarning|LintError} problem A lint problem
     * @returns {undefined} Any return value is ignored.
     */

    if (IN_NODE_JS) {
        // cheerio; Node.js
        /**
         * Lints the given HTML.
         * @param {string} html The HTML to lint
         * @param {reporter} reporter Function to call with each lint problem
         * @param {string[]} disabledIds Array of string IDs of linters to disable
         * @returns {undefined} Nothing
         */
        exports.lintHtml = function (html, reporter, disabledIds) {
            var $ = cheerio.load(html, {withStartIndices: true});
            this._lint($, reporter, disabledIds, html);
        };
    } else {
        // jQuery; in-browser
        /* @covignore */
        (function () {
            var $ = cheerio;
            /**
             * Lints the HTML of the current document.
             * @param {reporter} reporter Function to call with each lint problem
             * @param {string[]} disabledIds Array of string IDs of linters to disable
             * @returns {undefined} Nothing
             */
            exports.lintCurrentDocument = function (reporter, disabledIds) {
                this._lint($, reporter, disabledIds);
            };
            /**
             * Lints the HTML of the current document.
             * If there are any lint warnings, one general notification message will be window.alert()-ed to the user.
             * Each warning will be output individually using console.warn().
             * @param {string[]} disabledIds Array of string IDs of linters to disable
             * @param {object} [alertOpts] Options object to configure alert()ing
             * @param {boolean} [alertOpts.hasProblems=true] Show one alert() when the first lint problem is found?
             * @param {boolean} [alertOpts.problemFree=true] Show one alert() at the end of linting if the page has no lint problems?
             * @returns {undefined} Nothing
             */
            exports.showLintReportForCurrentDocument = function (disabledIds, alertOpts) {
                alertOpts = alertOpts || {};
                var alertOnFirstProblem = alertOpts.hasProblems || typeof alertOpts.hasProblems === 'undefined';
                var alertIfNoProblems = alertOpts.problemFree || typeof alertOpts.problemFree === 'undefined';

                var seenLint = false;
                var errorCount = 0;
                var reporter = function (lint) {
                    var background = 'background: #' + (lint.id[0] === 'W' ? 'f0ad4e' : 'd9534f') + '; color: #ffffff;';
                    if (!seenLint) {
                        if (alertOnFirstProblem) {
                            /* eslint-disable no-alert, no-undef, block-scoped-var */
                            window.alert('bootlint found errors in this document! See the JavaScript console for details.');
                            /* eslint-enable no-alert, no-undef, block-scoped-var */
                        }
                        seenLint = true;
                    }

                    if (lint.elements.length) {
                        console.warn('bootlint: %c ' + lint.id + ' ', background, lint.message + ' Documentation: ' + lint.url, lint.elements);
                    } else {
                        console.warn('bootlint: %c ' + lint.id + ' ', background, lint.message + ' Documentation: ' + lint.url);
                    }
                    errorCount++;
                };
                this.lintCurrentDocument(reporter, disabledIds);

                if (errorCount > 0) {
                    console.info('bootlint: For details, look up the lint problem IDs in the Bootlint wiki: https://github.com/twbs/bootlint/wiki');
                } else if (alertIfNoProblems) {
                    /* eslint-disable no-alert, no-undef, block-scoped-var */
                    window.alert('bootlint found no errors in this document.');
                    /* eslint-enable no-alert, no-undef, block-scoped-var */
                }
            };
            /* eslint-disable no-undef, block-scoped-var */
            window.bootlint = exports;
            /* eslint-enable no-undef, block-scoped-var */
        })();
    }
})(typeof exports === 'object' && exports || this);
