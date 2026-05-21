## Enemy NPC entity.
##
## Inherits Entity; patrols between waypoints and attacks any Player that
## enters its detection radius.  The `patrol_speed` export and the
## `attack()` method are labeled for the references fixture.
class_name Enemy
extends Entity

# ---------------------------------------------------------------------------
# Signals
# ---------------------------------------------------------------------------

## Emitted when the enemy starts chasing a target.
signal chase_started(target: Node)

# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------

## Walking speed while patrolling.
@export var patrol_speed: float = 80.0

## Running speed while chasing.
@export var chase_speed: float = 160.0

## Attack damage dealt per hit.
@export var attack_damage: int = 15

## Radius within which a player is detected.
@export var detection_radius: float = 200.0

## Ordered list of patrol waypoints (Vector2 positions in world space).
@export var waypoints: Array[Vector2] = []

var _current_waypoint_index: int = 0
var _target: Node = null

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

func _ready() -> void:
	super._ready()


func _physics_process(delta: float) -> void:
	if _target != null:
		_chase(delta)
	else:
		_patrol(delta)


# ---------------------------------------------------------------------------
# AI
# ---------------------------------------------------------------------------

## Move toward the next patrol waypoint.
func _patrol(delta: float) -> void:
	if waypoints.is_empty():
		return
	var destination: Vector2 = waypoints[_current_waypoint_index]
	var direction: Vector2 = (destination - global_position).normalized()
	global_position += direction * patrol_speed * delta
	if global_position.distance_to(destination) < 4.0:
		_current_waypoint_index = (_current_waypoint_index + 1) % waypoints.size()


## Move toward the current chase target.
func _chase(delta: float) -> void:
	if not is_instance_valid(_target):
		_target = null
		return
	var direction: Vector2 = (_target.global_position - global_position).normalized()
	global_position += direction * chase_speed * delta


## Deal attack_damage to `target` if it exposes a take_damage method.
func attack(target: Node) -> void:
	if target.has_method("take_damage"):
		target.take_damage(attack_damage)


## Begin chasing `node`; emits chase_started.
func start_chase(node: Node) -> void:
	_target = node
	chase_started.emit(node)
