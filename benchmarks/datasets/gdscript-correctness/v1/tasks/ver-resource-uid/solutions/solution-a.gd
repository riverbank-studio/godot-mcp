func load_by_uid(uid_string: String) -> Resource:
	var id := ResourceUID.text_to_id(uid_string)
	if not ResourceUID.has_id(id):
		return null
	var path := ResourceUID.get_id_path(id)
	return load(path)
