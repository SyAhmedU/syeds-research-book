"""Compile exact literal alternatives while trying longer shared prefixes first."""
import re

def literal_pattern(terms):
    root = {}
    for term in terms:
        node = root
        for character in term:
            node = node.setdefault(character, {})
        node[None] = True

    def pattern(node):
        choices = [re.escape(character) + pattern(node[character])
                   for character in sorted(key for key in node if key is not None)]
        if None in node:
            choices.append('')
        return choices[0] if len(choices) == 1 else '(?:' + '|'.join(choices) + ')'

    return pattern(root) if root else r'(?!)'
