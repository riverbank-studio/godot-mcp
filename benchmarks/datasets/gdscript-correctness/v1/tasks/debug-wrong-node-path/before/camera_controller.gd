extends Camera2D

## Player is a sibling node of this camera in the scene tree
var _player: CharacterBody2D

func _ready() -> void:
	# bug: absolute path breaks when scene is re-parented or instanced elsewhere
	_player = get_node("/root/GameScene/Player")

func _process(_delta: float) -> void:
	if _player:
		global_position = _player.global_position
