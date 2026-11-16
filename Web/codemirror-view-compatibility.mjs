import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const sourceSHA256 = 'e1ee658a4f903317aa6a573b993b78c5552307cba4c4b838335e9ef079d82451';
const original = `    static of(widget, view, length, flags, dom) {
        if (!dom) {
            dom = widget.toDOM(view);
            if (!widget.editable)
                dom.contentEditable = "false";
        }
        return new WidgetTile(dom, length, widget, flags);
    }`;
const compatible = `    static of(widget, view, length, flags, dom) {
        const constructorArgs = [dom, length, widget, flags];
        if (!dom) {
            dom = widget.toDOM(view);
            if (!widget.editable)
                dom.contentEditable = "false";
        }
        constructorArgs[0] = dom;
        return Reflect.construct(WidgetTile, constructorArgs);
    }`;

export function codemirrorViewCompatibility() {
  return {
    name: 'codemirror-view-widget-arguments',
    setup(build) {
      build.onLoad({ filter: /[/\\]@codemirror[/\\]view[/\\]dist[/\\]index\.js$/ }, async ({ path }) => {
        const source = await readFile(path, 'utf8');
        if (createHash('sha256').update(source).digest('hex') !== sourceSHA256 || source.split(original).length !== 2) {
          throw new Error('The pinned CodeMirror view 6.43.15 widget factory differs; review its compatibility transform before building.');
        }
        // Keep the original arguments rooted across nested widget DOM creation.
        // No length coercion, node skipping, or editor-state reconstruction.
        return { contents: source.replace(original, compatible), loader: 'js' };
      });
    }
  };
}
