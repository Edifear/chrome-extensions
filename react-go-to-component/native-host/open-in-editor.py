#!/usr/bin/env python3 -u
import sys
import json
import struct
import subprocess
import os
import re

def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) == 0:
        sys.exit(0)
    length = struct.unpack('@I', raw)[0]
    data = sys.stdin.buffer.read(length).decode('utf-8')
    return json.loads(data)

def send_message(obj):
    encoded = json.dumps(obj).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('@I', len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()

def find_best_line(lines, hints, fallback_line):
    """Score each line by how many hints it contains, return the best match."""
    if not hints:
        return fallback_line

    best_line = fallback_line
    best_score = 0

    for i, line_text in enumerate(lines):
        score = 0
        for hint in hints:
            if hint in line_text:
                # Longer matches are more valuable
                score += len(hint)
        if score > best_score:
            best_score = score
            best_line = i + 1

    return best_line

def validate_path_under(file_path, root):
    """Resolve symlinks/traversal and ensure file_path is under root."""
    real_file = os.path.realpath(file_path)
    real_root = os.path.realpath(root)
    if not real_file.startswith(real_root + os.sep) and real_file != real_root:
        raise ValueError(f'Path {file_path} is outside project root {root}')
    return real_file

def validate_editor(editor):
    """Ensure editor is an existing executable, not a shell command."""
    if not editor or not isinstance(editor, str):
        raise ValueError('Invalid editor path')
    # Reject shell metacharacters
    if re.search(r'[;&|`$(){}!\n]', editor):
        raise ValueError(f'Editor path contains disallowed characters: {editor}')
    resolved = os.path.realpath(editor)
    if not os.path.isfile(resolved):
        raise ValueError(f'Editor not found: {editor}')
    if not os.access(resolved, os.X_OK):
        raise ValueError(f'Editor is not executable: {editor}')
    return resolved

msg = read_message()
cmd = msg.get('cmd', 'open')

if cmd == 'open':
    file_path = msg.get('file')
    editor = msg.get('editor', '/usr/local/bin/code')
    editor_args = msg.get('editorArgs', ['--goto'])
    project_root = msg.get('projectRoot', '')
    if file_path:
        try:
            editor = validate_editor(editor)
            # Validate editor args: reject anything with shell metacharacters
            for arg in editor_args:
                if re.search(r'[;&|`$(){}!\n]', str(arg)):
                    raise ValueError(f'Editor arg contains disallowed characters: {arg}')
            # file_path may contain :line:col suffix (e.g. /path/file.js:10:0)
            # Extract the real path portion for validation
            parts = file_path.split(':')
            raw_path = parts[0]
            if project_root:
                validate_path_under(raw_path, project_root)
            subprocess.Popen([editor] + editor_args + [file_path])
            send_message({'success': True})
        except Exception as e:
            send_message({'success': False, 'error': str(e)})
    else:
        send_message({'success': False, 'error': 'No file path provided'})

elif cmd == 'read':
    file_path = msg.get('file', '')
    fallback_line = msg.get('line', 1)
    context = msg.get('context', 5)
    hints = msg.get('hints', [])
    project_root = msg.get('projectRoot', '')
    try:
        if project_root:
            validate_path_under(file_path, project_root)
        with open(file_path, 'r') as f:
            all_lines = f.readlines()

        # Clamp fallback to file bounds
        total = len(all_lines)
        fallback_line = max(1, min(fallback_line, total))

        # Find best matching line using hints
        target_line = find_best_line(
            [l.rstrip('\n') for l in all_lines],
            hints,
            fallback_line
        )
        target_line = max(1, min(target_line, total))

        start = max(0, target_line - context - 1)
        end = min(len(all_lines), target_line + context)
        snippet = []
        for i in range(start, end):
            snippet.append({'num': i + 1, 'text': all_lines[i].rstrip('\n')})

        # Trim trivial first/last lines (lone brackets, parens, closing tags, etc.)
        # Matches lines with only punctuation/whitespace like ")", "});", ") {", "/>", "</div>"
        trivial = re.compile(r'^\s*[\(\)\{\}\[\]<>/;:,.\s]*$')
        while len(snippet) > 1 and snippet[0]['num'] != target_line and trivial.match(snippet[0]['text']):
            snippet.pop(0)
        while len(snippet) > 1 and snippet[-1]['num'] != target_line and trivial.match(snippet[-1]['text']):
            snippet.pop()

        send_message({'success': True, 'lines': snippet, 'targetLine': target_line})
    except Exception as e:
        send_message({'success': False, 'error': str(e)})

else:
    send_message({'success': False, 'error': f'Unknown command: {cmd}'})
