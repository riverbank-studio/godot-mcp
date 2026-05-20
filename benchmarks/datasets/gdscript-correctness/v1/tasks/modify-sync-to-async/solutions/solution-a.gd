extends Node

const texture_path := "res://assets/player.png"

func _ready() -> void:
	ResourceLoader.load_threaded_request(texture_path)

func _process(_delta: float) -> void:
	var status := ResourceLoader.load_threaded_get_status(texture_path)
	if status == ResourceLoader.THREAD_LOAD_LOADED:
		var texture := ResourceLoader.load_threaded_get(texture_path) as Texture2D
		$Sprite2D.texture = texture
		set_process(false)
