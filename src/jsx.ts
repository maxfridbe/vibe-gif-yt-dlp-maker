import { VNode, VNodeData, Key } from './vendor/snabbdom/vnode.js';
import { h } from './vendor/snabbdom/h.js';

export type JsxChild = VNode | string | number | boolean | null | undefined;

export function Fragment(_props: any, ...children: any[]): any {
  return flatten(children);
}

function flatten(arr: any[]): any[] {
  const res: any[] = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      res.push(...flatten(item));
    } else if (item !== null && item !== undefined && item !== false) {
      res.push(item);
    }
  }
  return res;
}

export function jsx(tag: any, props: any, ...children: any[]): VNode {
  const flatChildren = flatten(children);

  if (typeof tag === 'function') {
    return tag(props || {}, flatChildren);
  }

  const data: VNodeData = {};
  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (val === undefined || val === null) continue;

      if (key === 'key') {
        data.key = val as Key;
      } else if (key === 'hook') {
        data.hook = val as any;
      } else if (key === 'class' || key === 'className') {
        if (typeof val === 'string') {
          data.attrs = data.attrs || {};
          data.attrs.class = val;
        } else {
          data.class = val as Record<string, boolean>;
        }
      } else if (key === 'style') {
        data.style = val as any;
      } else if (key.startsWith('on') && key.length > 2 && typeof val === 'function') {
        const evName = key.slice(2).toLowerCase();
        data.on = data.on || {};
        data.on[evName] = val as any;
      } else if (key === 'on' || key === 'attrs' || key === 'props' || key === 'dataset') {
        (data as any)[key] = Object.assign((data as any)[key] || {}, val);
      } else {
        data.attrs = data.attrs || {};
        (data.attrs as any)[key] = val;
        data.props = data.props || {};
        (data.props as any)[key] = val;
      }
    }
  }

  return h(tag, data, flatChildren);
}

// Global JSX namespace for TypeScript
declare global {
  namespace JSX {
    type Element = VNode;
    interface IntrinsicElements {
      [elemName: string]: any;
    }
  }
}
