extends Camera2D

## Player is a sibling node of this camera in the scene tree
@export var player_path: NodePath
var _player: CharacterBody2D

func _ready() -> void:
	if player_path:
		_player = get_node(player_path) as CharacterBody2D
	else:
		_player = get_node("../Player") as CharacterBody2D

func _process(_delta: float) -> void:
	if _player:
		global_position = _player.global_position
