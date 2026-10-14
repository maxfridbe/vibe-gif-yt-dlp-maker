import { h } from './vendor/snabbdom/h.js';
export function Fragment(_props, ...children) {
    return flatten(children);
}
function flatten(arr) {
    const res = [];
    for (const item of arr) {
        if (Array.isArray(item)) {
            res.push(...flatten(item));
        }
        else if (item !== null && item !== undefined && item !== false) {
            res.push(item);
        }
    }
    return res;
}
export function jsx(tag, props, ...children) {
    const flatChildren = flatten(children);
    if (typeof tag === 'function') {
        return tag(props || {}, flatChildren);
    }
    const data = {};
    if (props) {
        for (const [key, val] of Object.entries(props)) {
            if (val === undefined || val === null)
                continue;
            if (key === 'key') {
                data.key = val;
            }
            else if (key === 'hook') {
                data.hook = val;
            }
            else if (key === 'class' || key === 'className') {
                if (typeof val === 'string') {
                    data.attrs = data.attrs || {};
                    data.attrs.class = val;
                }
                else {
                    data.class = val;
                }
            }
            else if (key === 'style') {
                data.style = val;
            }
            else if (key.startsWith('on') && key.length > 2 && typeof val === 'function') {
                const evName = key.slice(2).toLowerCase();
                data.on = data.on || {};
                data.on[evName] = val;
            }
            else if (key === 'on' || key === 'attrs' || key === 'props' || key === 'dataset') {
                data[key] = Object.assign(data[key] || {}, val);
            }
            else {
                data.attrs = data.attrs || {};
                data.attrs[key] = val;
                data.props = data.props || {};
                data.props[key] = val;
            }
        }
    }
    return h(tag, data, flatChildren);
}
