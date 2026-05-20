"""Hand-curated Godot-docs sample corpus for FTS5 tokenizer / BM25 A/B testing.

Why hand-curated rather than fetching live godot-docs?
- Issue #39 explicitly permits a mocked subset.
- An A/B harness needs LABELED relevance judgements; live docs would still
  require manual labeling. The bottleneck is judgements, not text.
- The corpus deliberately exercises the cases the tokenizer / weight choices
  affect: snake_case identifiers (add_child), PascalCase class names
  (AnimationPlayer), partial prefixes (Anim → AnimationPlayer), and prose
  phrases (\"how to play a sound\").

Three corpora mirror the three FTS5 tables in docs/DESIGN.md § Search:
- classes:   (name, brief)
- members:   (name, signature, description)
- tutorials: (title, heading_path, content)

Field text is paraphrased from Godot 4 docs (https://docs.godotengine.org)
to keep the sample standalone; phrasings are close enough to real docs that
tokenizer behaviour generalizes.
"""

# ---------------------------------------------------------------------------
# Class index
# ---------------------------------------------------------------------------
CLASSES = [
    ("Node", "Base class for all scene tree nodes. Provides the scene tree and signal infrastructure."),
    ("Node2D", "A 2D game object. Inherits from CanvasItem. Provides position, rotation, scale."),
    ("Node3D", "Most basic 3D game object. Inherits from Node. Provides transform in 3D space."),
    ("AnimationPlayer", "Plays back animation resources. Controls animation playback timeline and blending."),
    ("AnimationTree", "A node used for advanced animation transitions in an AnimationPlayer."),
    ("AnimatedSprite2D", "Sprite node that contains multiple textures for animated frames."),
    ("AudioStreamPlayer", "Plays back audio non-positionally. Use this for music or UI sounds."),
    ("AudioStreamPlayer2D", "Plays positional sound in 2D space."),
    ("CharacterBody2D", "A 2D physics body specialized for characters moved by script. Use move_and_slide."),
    ("CharacterBody3D", "A 3D physics body specialized for characters moved by script."),
    ("RigidBody2D", "A 2D physics body that is moved by a physics simulation."),
    ("RigidBody3D", "A 3D physics body that is moved by a physics simulation."),
    ("StaticBody2D", "A 2D physics body that can not be moved by external forces."),
    ("Area2D", "A 2D region that detects other CollisionObject2D nodes overlapping or entering it."),
    ("Sprite2D", "A 2D sprite node. Used to draw a single 2D texture in the world."),
    ("Label", "A control that displays plain text. Supports horizontal and vertical alignment."),
    ("Button", "Standard themed button. Emits a pressed signal when clicked."),
    ("Control", "Base class for all UI nodes. Provides anchors, margins, and theme."),
    ("Camera2D", "Camera node for 2D scenes. Limits, smoothing, and drag margins."),
    ("Camera3D", "Camera node for 3D scenes. Projects the 3D world to a 2D viewport."),
    ("Tween", "Lightweight object used for tweening properties. Replaces SceneTreeTween in Godot 4."),
    ("Timer", "Counts down a specified interval and emits a timeout signal at the end."),
    ("PackedScene", "A scene serialized to disk. Instantiate with PackedScene.instantiate()."),
    ("Resource", "Base class for all resources. Reference-counted and serializable."),
    ("Signal", "A first-class signal value. Connect, disconnect, and emit from script."),
]

# ---------------------------------------------------------------------------
# Member index — methods, properties, signals
# ---------------------------------------------------------------------------
MEMBERS = [
    ("add_child", "void add_child(node: Node, force_readable_name: bool = false, internal: InternalMode = 0)",
     "Adds a child node. Nodes can have any number of children, but every child must have a unique name."),
    ("remove_child", "void remove_child(node: Node)",
     "Removes a child node. The node is NOT deleted and must be deleted manually."),
    ("get_child", "Node get_child(idx: int, include_internal: bool = false)",
     "Returns a child node by its index. Negative indices count from the end."),
    ("get_children", "Array[Node] get_children(include_internal: bool = false)",
     "Returns all the children of this node inside an array. Useful for iteration."),
    ("queue_free", "void queue_free()",
     "Queues a node for deletion at the end of the current frame."),
    ("move_and_slide", "bool move_and_slide()",
     "Moves a CharacterBody2D or CharacterBody3D based on velocity and handles collision sliding."),
    ("move_and_collide", "KinematicCollision2D move_and_collide(motion: Vector2, test_only: bool = false)",
     "Moves the body and stops on the first collision. Returns collision information."),
    ("play", "void play(name: StringName = &\"\", custom_blend: float = -1.0, custom_speed: float = 1.0, from_end: bool = false)",
     "Plays the animation with the given name on the AnimationPlayer. If no name, plays the current animation."),
    ("stop", "void stop(keep_state: bool = false)",
     "Stops the currently playing animation on the AnimationPlayer."),
    ("connect", "Error connect(signal: StringName, callable: Callable, flags: int = 0)",
     "Connects a signal to a callable. Use Object.connect to subscribe to signals."),
    ("emit_signal", "Error emit_signal(signal: StringName, ...) vararg",
     "Emits the given signal with the supplied arguments. Triggers connected callables."),
    ("set_process", "void set_process(enable: bool)",
     "Enables or disables _process() callback. The node will receive frame updates."),
    ("set_physics_process", "void set_physics_process(enable: bool)",
     "Enables or disables _physics_process() callback for fixed-rate physics updates."),
    ("instantiate", "Node instantiate(edit_state: GenEditState = 0)",
     "Instantiates the PackedScene, returning the root Node of the new scene."),
    ("load", "Resource load(path: String, type_hint: String = \"\", cache_mode: CacheMode = 1)",
     "Loads a resource from the filesystem at the given path. ResourceLoader handles caching."),
    ("preload", "Resource preload(path: String)",
     "Loads a resource at parse time. The path must be a string literal."),
    ("tween_property", "PropertyTweener tween_property(object: Object, property: NodePath, final_val: Variant, duration: float)",
     "Creates a tweener animating a property of an object to a final value over a duration."),
    ("start", "void start(time_sec: float = -1.0)",
     "Starts the Timer with the given wait time. Emits timeout when finished."),
    ("position", "Vector2 position",
     "The node's position in 2D space, relative to its parent. Setting modifies the transform."),
    ("global_position", "Vector2 global_position",
     "The node's global position in 2D space. Setting modifies the world transform."),
    ("velocity", "Vector2 velocity",
     "The body's linear velocity in 2D space. Used by move_and_slide on CharacterBody2D."),
    ("text", "String text",
     "The label's displayed text. Supports unicode and BBCode in RichTextLabel."),
    ("pressed", "signal pressed()",
     "Emitted when the button is pressed. Connect to handle clicks."),
    ("body_entered", "signal body_entered(body: Node2D)",
     "Emitted when a PhysicsBody2D or TileMap enters the Area2D. Useful for trigger volumes."),
    ("timeout", "signal timeout()",
     "Emitted when the Timer reaches zero. Connect to schedule callbacks."),
    ("tree_entered", "signal tree_entered()",
     "Emitted when the node enters the scene tree. Useful for one-time setup."),
    ("ready", "signal ready()",
     "Emitted when the node and its children have entered the scene tree and are ready."),
]

# ---------------------------------------------------------------------------
# Tutorial chunks
# ---------------------------------------------------------------------------
TUTORIALS = [
    ("Your first 2D game",
     "Getting started > Step by step > Your first 2D game > The Player scene",
     "Create a new scene with a CharacterBody2D root. Add an AnimatedSprite2D for the visuals and a CollisionShape2D for physics interactions. In the script, use move_and_slide to handle motion based on the velocity property."),

    ("Your first 2D game",
     "Getting started > Step by step > Your first 2D game > Moving the player",
     "Read input using Input.is_action_pressed. Multiply by a speed constant to derive a velocity vector. Call move_and_slide once per _physics_process tick. Update the AnimatedSprite2D's current animation based on the input direction."),

    ("Playing sounds and music",
     "Tutorials > Audio > Playing sounds and music",
     "Use AudioStreamPlayer for non-positional sounds like UI feedback or music. For sounds anchored to a position in 2D space, use AudioStreamPlayer2D. Call play() on the node to start playback. Connect the finished signal to know when the sound completes."),

    ("Using AnimationPlayer",
     "Tutorials > Animation > Using AnimationPlayer",
     "AnimationPlayer animates any property of any node by interpolating keyframes across a timeline. Create a new Animation resource, add tracks for each property, and place keyframes. Call play(\"animation_name\") from script. Use AnimationTree for state-machine-style blending of multiple animations."),

    ("Signals",
     "Getting started > First look at Godot > Signals",
     "Signals are Godot's observer pattern. Emit a signal from one node and connect a callable in another to react. Built-in signals include Timer.timeout, Button.pressed, and Area2D.body_entered. Connect with Object.connect in code or via the editor's Node dock."),

    ("Custom signals",
     "Tutorials > Scripting > GDScript > Signals",
     "Declare a custom signal in GDScript with the signal keyword. Emit it with emit_signal or by calling the signal as a method. Connect from other scripts using my_node.my_signal.connect(callable). Signals carry arguments declared in their signature."),

    ("Instancing scenes",
     "Getting started > Step by step > Instancing",
     "Save a scene to disk as a .tscn file. Load it as a PackedScene and call instantiate() to create a new Node hierarchy. Use add_child to attach it to the running tree. Useful for spawning bullets, enemies, particles."),

    ("CharacterBody2D physics",
     "Tutorials > Physics > Using CharacterBody2D",
     "CharacterBody2D is a kinematic body suited for player- or AI-driven movement. Set the velocity property and call move_and_slide each physics frame. Read is_on_floor, is_on_wall, get_slide_collision for response logic."),

    ("RigidBody2D physics",
     "Tutorials > Physics > Using RigidBody2D",
     "RigidBody2D is simulated by the physics engine. Apply forces with apply_impulse or apply_force; do not set position directly. Use a CollisionShape2D child for the body shape. RigidBody2D nodes interact with Area2D for triggers."),

    ("Saving and loading",
     "Tutorials > Scripting > Saving games",
     "Use FileAccess.open with WRITE to serialize game state as JSON. For binary saves, use store_var. Load by reading the file and parsing JSON. ConfigFile is convenient for simple key/value settings."),

    ("Singletons (Autoload)",
     "Tutorials > Scripting > Singletons (Autoload)",
     "Register a script as a singleton in Project Settings > Autoload. The script becomes globally accessible by its node name. Useful for game state, settings, event buses with custom signals."),

    ("Using Tween",
     "Tutorials > Animation > Using Tween",
     "Create a Tween at runtime with create_tween(). Call tween_property to animate a property to a final value over a duration. Chain tween_property calls for sequences. Tweens automatically free themselves when finished."),

    ("Resources and Scenes",
     "Tutorials > Best practices > Data preferences",
     "Resources are reference-counted data containers shared between scenes. PackedScene is itself a Resource. Use preload for compile-time loading, load for runtime. Prefer Resources over JSON for typed game data."),

    ("Input handling",
     "Tutorials > Inputs > Input handling",
     "Configure input actions in Project Settings > Input Map. In script, use Input.is_action_pressed for held input and Input.is_action_just_pressed for one-frame triggers. Override _input or _unhandled_input for per-event handling."),

    ("Scene tree",
     "Tutorials > Best practices > Scene organization",
     "The scene tree is Godot's node hierarchy. Use add_child to attach nodes; remove_child to detach without freeing. queue_free schedules deletion at frame end. Iterate children with get_children or get_child(idx)."),
]


def all_classes():
    """Yield (rowid, name, brief) tuples for the class index."""
    for i, (n, b) in enumerate(CLASSES, start=1):
        yield i, n, b


def all_members():
    """Yield (rowid, name, signature, description) tuples for the member index."""
    for i, (n, s, d) in enumerate(MEMBERS, start=1):
        yield i, n, s, d


def all_tutorials():
    """Yield (rowid, title, heading_path, content) tuples for the tutorial index."""
    for i, (t, h, c) in enumerate(TUTORIALS, start=1):
        yield i, t, h, c
