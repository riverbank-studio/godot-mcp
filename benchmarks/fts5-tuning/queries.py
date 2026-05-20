"""Labeled query set for FTS5 tokenizer / BM25 weight evaluation.

Each entry is (query_string, target_table, relevant_rowids).
rowids match the 1-based insertion order in corpus.py.

Query buckets:
- ident:    snake_case identifier lookup       (tests tokenchars='_')
- pascal:   exact PascalCase class lookup       (tests case folding)
- partial:  prefix or substring of a name       (tests trigram)
- howto:    prose phrase lookup                 (tests porter stemming)
- field:    expected-field-bias lookup          (tests bm25 weights)
"""

CLASS_QUERIES = [
    # PascalCase exact
    ("pascal", "AnimationPlayer", [4]),
    ("pascal", "CharacterBody2D", [9]),
    ("pascal", "RigidBody2D", [11]),
    ("pascal", "Node2D", [2]),
    # Partial / prefix lookups — the trigram-vs-unicode61 question
    ("partial", "Anim", [4, 5, 6]),               # AnimationPlayer, AnimationTree, AnimatedSprite2D
    ("partial", "Body2D", [9, 11, 13]),           # CharacterBody2D, RigidBody2D, StaticBody2D
    ("partial", "Sprite", [6, 15]),               # AnimatedSprite2D, Sprite2D
    ("partial", "Stream", [7, 8]),                # AudioStreamPlayer, AudioStreamPlayer2D
    # How-to phrases that should land on the right class
    ("howto", "play animation", [4]),
    ("howto", "play sound", [7, 8]),
    ("howto", "physics body 2D", [9, 11, 13]),
    ("howto", "scene tree node", [1]),
]

MEMBER_QUERIES = [
    # snake_case identifier lookups — directly tests tokenchars='_'
    ("ident", "add_child", [1]),
    ("ident", "remove_child", [2]),
    ("ident", "move_and_slide", [6]),
    ("ident", "queue_free", [5]),
    ("ident", "emit_signal", [11]),
    ("ident", "set_physics_process", [13]),
    ("ident", "tween_property", [17]),
    ("ident", "global_position", [20]),
    # Partial identifier (tests trigram)
    ("partial", "move_and", [6, 7]),              # move_and_slide, move_and_collide
    ("partial", "set_", [12, 13]),                # set_process, set_physics_process
    # How-to phrases biased toward description field
    ("howto", "add a child node", [1]),
    ("howto", "delete a node", [5]),
    ("howto", "fixed rate physics callback", [13]),
    ("howto", "tween a property", [17]),
    # Signal-name queries
    ("ident", "body_entered", [24]),
    ("ident", "timeout", [25]),
]

TUTORIAL_QUERIES = [
    # How-to prose queries — porter stemming territory
    ("howto", "how to play a sound", [3]),
    ("howto", "playing music", [3]),
    ("howto", "instancing scenes", [7]),
    ("howto", "save game state", [10]),
    ("howto", "moving the player character", [1, 2, 8]),
    ("howto", "input handling", [14]),
    ("howto", "singletons autoload", [11]),
    ("howto", "custom signals", [6]),
    ("howto", "scene tree", [15]),
    # Field-weight queries — title should win over content
    ("field", "AnimationPlayer", [4]),            # title hit
    ("field", "Signals", [5, 6]),                 # title hit
    ("field", "CharacterBody2D", [8]),            # title hit
    # Stemming-sensitive (plurals / -ing)
    ("howto", "animating properties", [4, 12]),
    ("howto", "saved games", [10]),
]
