## Base entity class providing shared identity and lifecycle helpers.
##
## All game objects that live on the node tree inherit from this class.
## It exposes a stable `entity_id` and a `despawn()` convenience that emits
## `about_to_despawn` before freeing itself.
class_name Entity
extends Node

# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

## Emitted just before the entity frees itself via despawn().
signal about_to_despawn(entity: Entity)

# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------

## Stable per-instance identifier assigned at _ready.
var entity_id: int = 0

## Human-readable tag used in debug output.
@export var debug_tag: String = "entity"

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

func _ready() -> void:
	entity_id = get_instance_id()


## Free this entity after emitting about_to_despawn.
func despawn() -> void:
	about_to_despawn.emit(self)
	queue_free()


# ---------------------------------------------------------------------------
# Queries
# ---------------------------------------------------------------------------

## Return true if this entity has been marked for deletion.
func is_despawning() -> bool:
	return not is_inside_tree() or is_queued_for_deletion()
